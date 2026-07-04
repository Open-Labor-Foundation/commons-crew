import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parseDocument } from "yaml";
import type {
  CatalogEntry,
  CatalogSyncRecord,
  SpecialistInputContract,
  SpecialistManifestContract,
  SpecialistManifestValidationIssue,
  SpecialistOutputContract,
  SpecialistReadinessState,
  SpecialistStartupCheckContract
} from "../../contracts/src/index";
import type { AppConfig } from "../../config/src/index";

const execFileAsync = promisify(execFile);

type ManifestRecord = Record<string, unknown>;
type ValidationCheck = {
  name: string;
  ok: boolean;
  details: string;
};
type CatalogManifestRecord = {
  entry: CatalogEntry;
  manifest: SpecialistManifestContract;
  manifestPath: string;
  rawManifest: string;
  resolvedRef: string;
  resolvedCommit: string;
  validationChecks: ValidationCheck[];
};

const CONTRACT_SCHEMA_VERSION = "olf.specialist/v1";
const CONTRACT_KIND = "specialist";
const LEGACY_SCHEMA_VERSION = "1.0";
const LEGACY_KIND = "agent_definition";
const READINESS_STATES: SpecialistReadinessState[] = ["validated", "deployable", "definition_only", "partial", "planned"];
const DEFAULT_STARTUP_CHECKS: SpecialistStartupCheckContract[] = [
  {
    id: "provider-commons-crew-auth",
    kind: "provider_auth",
    target: "commons-crew",
    required: true
  },
  {
    id: "approval-hook",
    kind: "approval_hook",
    target: "commons-keeper",
    required: true
  }
];

export class ManifestValidationError extends Error {
  constructor(readonly issues: SpecialistManifestValidationIssue[]) {
    super(issues.map((entry) => `${entry.manifestPath}:${entry.path}: ${entry.message}`).join("\n"));
    this.name = "ManifestValidationError";
  }
}

export async function loadSpecialistManifest(manifestPath: string): Promise<SpecialistManifestContract> {
  const source = await fs.readFile(manifestPath, "utf8");
  return parseSpecialistManifest(source, manifestPath);
}

export function parseSpecialistManifest(source: string, manifestPath: string): SpecialistManifestContract {
  if (looksLikeLegacyManifest(source)) {
    return parseLegacyContractSource(source, manifestPath);
  }

  const document = parseDocument(source);
  const parseIssues = document.errors.map<SpecialistManifestValidationIssue>((error) => ({
    code: "manifest.parse_error",
    message: error.message,
    path: "$",
    manifestPath,
    line: error.linePos?.[0]?.line ?? null,
    column: error.linePos?.[0]?.col ?? null
  }));
  if (parseIssues.length > 0) {
    throw new ManifestValidationError(parseIssues);
  }

  const value = document.toJS();
  if (!isRecord(value)) {
    throw new ManifestValidationError([issue("manifest.type", "Manifest root must be an object.", "$", manifestPath)]);
  }
  return hasExplicitContractShape(value) ? parseExplicitContract(value, manifestPath) : parseLegacyContract(value, manifestPath);
}

export class LocalCatalogService {
  private entries: CatalogEntry[] = [];
  private manifests = new Map<string, CatalogManifestRecord>();
  private syncs = new Map<string, CatalogSyncRecord>();
  private validationIssues: SpecialistManifestValidationIssue[] = [];

  constructor(private readonly config: AppConfig) {}

  async sync(): Promise<CatalogSyncRecord> {
    const startedAt = new Date().toISOString();
    const manifests = await this.findManifestFiles(this.config.paths.olfAgentsRoot);
    const entries: CatalogManifestRecord[] = [];
    const issues: SpecialistManifestValidationIssue[] = [];
    const { ref, commit } = await this.resolveGitRef();

    for (const manifestPath of manifests) {
      try {
        const rawManifest = await fs.readFile(manifestPath, "utf8");
        const manifest = parseSpecialistManifest(rawManifest, manifestPath);
        const entry = this.toEntry(manifestPath, manifest);
        entries.push({
          entry,
          manifest,
          manifestPath,
          rawManifest,
          resolvedRef: ref,
          resolvedCommit: commit,
          validationChecks: []
        });
      } catch (error) {
        if (error instanceof ManifestValidationError) {
          issues.push(...error.issues);
          continue;
        }
        throw error;
      }
    }

    this.entries = entries.map((record) => record.entry);
    this.manifests = new Map(entries.map((record) => [record.entry.id, record]));
    this.validationIssues = issues;
    const record: CatalogSyncRecord = {
      id: `sync_${Date.now()}`,
      sourcePath: this.config.paths.olfAgentsRoot,
      resolvedRef: ref,
      resolvedCommit: commit,
      status: "completed",
      startedAt,
      endedAt: new Date().toISOString(),
      entriesDiscovered: entries.length
    };
    this.syncs.set(record.id, record);
    return record;
  }

  async listEntries(): Promise<CatalogEntry[]> {
    return this.entries;
  }

  async getSync(syncId: string): Promise<CatalogSyncRecord | null> {
    return this.syncs.get(syncId) ?? null;
  }

  async listValidationIssues(): Promise<SpecialistManifestValidationIssue[]> {
    return this.validationIssues;
  }

  async getEntry(agentId: string): Promise<CatalogEntry | null> {
    return this.entries.find((entry) => entry.id === agentId) ?? null;
  }

  async getManifestRecord(agentId: string): Promise<CatalogManifestRecord | null> {
    return this.manifests.get(agentId) ?? null;
  }

  private async findManifestFiles(root: string): Promise<string[]> {
    const results: string[] = [];
    const agentsRoot = path.join(root, "catalog/naics-overlays");

    try {
      const stats = await fs.stat(agentsRoot);
      if (!stats.isDirectory()) {
        return [];
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    async function visit(current: string) {
      const items = await fs.readdir(current, { withFileTypes: true });
      for (const item of items) {
        const resolved = path.join(current, item.name);
        if (item.isDirectory()) {
          await visit(resolved);
          continue;
        }
        if (item.name.startsWith(".")) {
          continue;
        }
        if (item.isFile() && (item.name === "spec.yaml" || item.name === "spec.yml")) {
          results.push(resolved);
        }
      }
    }

    try {
      const agentsRootStatus = await fs.stat(agentsRoot);
      if (!agentsRootStatus.isDirectory()) {
        return results;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return results;
      }
      throw error;
    }

    await visit(agentsRoot);
    return results.sort();
  }

  private toEntry(manifestPath: string, manifest: SpecialistManifestContract): CatalogEntry {
    const relativePath = path.relative(this.config.paths.olfAgentsRoot, manifestPath);

    return {
      id: relativePath,
      sourcePath: relativePath,
      manifestPath,
      agentSlug: manifest.identity.slug,
      name: manifest.identity.name,
      readinessState: manifest.readinessState,
      status: "available",
      supportedTasks: manifest.supportedTasks,
      expectedOutputs: manifest.outputs.map((output) => output.name),
      manifest,
      validationWarnings: []
    };
  }

  private async resolveGitRef() {
    try {
      const { stdout: refOut } = await execFileAsync("git", ["-C", this.config.paths.olfAgentsRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
      const { stdout: commitOut } = await execFileAsync("git", ["-C", this.config.paths.olfAgentsRoot, "rev-parse", "HEAD"]);
      return {
        ref: refOut.trim(),
        commit: commitOut.trim()
      };
    } catch {
      return {
        ref: "unknown",
        commit: "unknown"
      };
    }
  }
}

function hasExplicitContractShape(value: ManifestRecord) {
  return "schemaVersion" in value || "identity" in value || "startupChecks" in value || "permissions" in value;
}

function looksLikeLegacyManifest(source: string) {
  return /^\s*schema_version:\s*["']1\.0["']\s*$/m.test(source) && /^\s*kind:\s*["']agent_definition["']\s*$/m.test(source);
}

function parseExplicitContract(value: ManifestRecord, manifestPath: string): SpecialistManifestContract {
  const issues: SpecialistManifestValidationIssue[] = [];
  readExpectedString(value, "schemaVersion", CONTRACT_SCHEMA_VERSION, manifestPath, issues);
  readExpectedString(value, "kind", CONTRACT_KIND, manifestPath, issues);
  const identityValue = readRecord(value, "identity", manifestPath, issues);
  const boundaryValue = identityValue ? readRecord(identityValue, "boundary", manifestPath, issues, "$.identity") : null;
  const permissionsValue = readRecord(value, "permissions", manifestPath, issues);

  const startupChecks = readArray(value, "startupChecks", manifestPath, issues, "$", 1).map((entry, index) => {
    const entryPath = `$.startupChecks[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue("manifest.type", "Startup checks must contain objects.", entryPath, manifestPath));
      return defaultStartupCheck();
    }

    return {
      id: readNonEmptyString(entry, "id", manifestPath, issues, entryPath),
      kind: readNonEmptyString(entry, "kind", manifestPath, issues, entryPath),
      target: readNonEmptyString(entry, "target", manifestPath, issues, entryPath),
      required: readBoolean(entry, "required", manifestPath, issues, entryPath)
    };
  });

  const contract: SpecialistManifestContract = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: CONTRACT_KIND,
    identity: {
      slug: readNonEmptyString(identityValue, "slug", manifestPath, issues, "$.identity"),
      name: readNonEmptyString(identityValue, "name", manifestPath, issues, "$.identity"),
      description: readNonEmptyString(identityValue, "description", manifestPath, issues, "$.identity"),
      boundary: {
        domain: readNonEmptyString(boundaryValue, "domain", manifestPath, issues, "$.identity.boundary"),
        constraints: readStringArray(boundaryValue, "constraints", manifestPath, issues, "$.identity.boundary", 1)
      }
    },
    readinessState: readReadinessState(value, "readinessState", manifestPath, issues, "$") ?? "definition_only",
    supportedTasks: readStringArray(value, "supportedTasks", manifestPath, issues, "$", 1),
    inputs: readNamedContracts(value, "inputs", manifestPath, issues, "$", false),
    outputs: readNamedContracts(value, "outputs", manifestPath, issues, "$", true),
    permissions: {
      approvalRequired: readBoolean(permissionsValue, "approvalRequired", manifestPath, issues, "$.permissions"),
      allow: readStringArray(permissionsValue, "allow", manifestPath, issues, "$.permissions", 1)
    },
    startupChecks
  };

  if (issues.length > 0) {
    throw new ManifestValidationError(issues);
  }

  return contract;
}

function parseLegacyContract(value: ManifestRecord, manifestPath: string): SpecialistManifestContract {
  const issues: SpecialistManifestValidationIssue[] = [];
  const metadata = readRecord(value, "metadata", manifestPath, issues);
  const purpose = readRecord(value, "purpose", manifestPath, issues);
  const scope = readRecord(value, "scope", manifestPath, issues);

  const legacyStatus = readNonEmptyString(metadata, "status", manifestPath, issues, "$.metadata");
  const purposeSummary = readNonEmptyString(purpose, "summary", manifestPath, issues, "$.purpose");
  const supportedTasks = readStringArray(scope, "supported_tasks", manifestPath, issues, "$.scope", 1);
  const commonInputs = readStringArray(scope, "common_inputs", manifestPath, issues, "$.scope", 1);
  const expectedOutputs = readStringArray(scope, "expected_outputs", manifestPath, issues, "$.scope", 1);
  const outOfScopeRules = readOptionalStringArray(scope, "out_of_scope_rules", manifestPath, issues, "$.scope");
  const orchestratorReturnRules = readOptionalStringArray(scope, "orchestrator_return_rules", manifestPath, issues, "$.scope");

  const contract: SpecialistManifestContract = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: CONTRACT_KIND,
    identity: {
      slug: readNonEmptyString(metadata, "slug", manifestPath, issues, "$.metadata"),
      name: readNonEmptyString(metadata, "name", manifestPath, issues, "$.metadata"),
      description: purposeSummary,
      boundary: {
        domain: readNonEmptyString(metadata, "domain_family", manifestPath, issues, "$.metadata"),
        constraints: normalizeConstraints([
          readNonEmptyString(metadata, "specialty_boundary", manifestPath, issues, "$.metadata"),
          ...outOfScopeRules,
          ...orchestratorReturnRules
        ])
      }
    },
    readinessState: mapLegacyStatus(legacyStatus, manifestPath, issues),
    supportedTasks,
    inputs: toLegacyInputs(commonInputs),
    outputs: toLegacyOutputs(expectedOutputs),
    permissions: {
      approvalRequired: true,
      allow: ["workspace.read"]
    },
    startupChecks: DEFAULT_STARTUP_CHECKS
  };

  readExpectedString(value, "schema_version", LEGACY_SCHEMA_VERSION, manifestPath, issues);
  readExpectedString(value, "kind", LEGACY_KIND, manifestPath, issues);

  if (issues.length > 0) {
    throw new ManifestValidationError(issues);
  }

  return contract;
}

function parseLegacyContractSource(source: string, manifestPath: string): SpecialistManifestContract {
  const issues: SpecialistManifestValidationIssue[] = [];
  const legacy = extractLegacyFields(source);

  const purposeSummary = readRawString(legacy.purpose, "summary", manifestPath, issues, "$.purpose");
  const supportedTasks = readRawStringArray(legacy.scope, "supported_tasks", manifestPath, issues, "$.scope", 1);
  const commonInputs = readRawStringArray(legacy.scope, "common_inputs", manifestPath, issues, "$.scope", 1);
  const expectedOutputs = readRawStringArray(legacy.scope, "expected_outputs", manifestPath, issues, "$.scope", 1);
  const outOfScopeRules = readRawStringArray(legacy.scope, "out_of_scope_rules", manifestPath, issues, "$.scope", 0);
  const orchestratorReturnRules = readRawStringArray(legacy.scope, "orchestrator_return_rules", manifestPath, issues, "$.scope", 0);

  const contract: SpecialistManifestContract = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    kind: CONTRACT_KIND,
    identity: {
      slug: readRawString(legacy.metadata, "slug", manifestPath, issues, "$.metadata"),
      name: readRawString(legacy.metadata, "name", manifestPath, issues, "$.metadata"),
      description: purposeSummary,
      boundary: {
        domain: readRawString(legacy.metadata, "domain_family", manifestPath, issues, "$.metadata"),
        constraints: normalizeConstraints([
          readRawString(legacy.metadata, "specialty_boundary", manifestPath, issues, "$.metadata"),
          ...outOfScopeRules,
          ...orchestratorReturnRules
        ])
      }
    },
    readinessState: mapLegacyStatus(readRawString(legacy.metadata, "status", manifestPath, issues, "$.metadata"), manifestPath, issues),
    supportedTasks,
    inputs: toLegacyInputs(commonInputs),
    outputs: toLegacyOutputs(expectedOutputs),
    permissions: {
      approvalRequired: true,
      allow: ["workspace.read"]
    },
    startupChecks: DEFAULT_STARTUP_CHECKS
  };

  if (legacy.schemaVersion !== LEGACY_SCHEMA_VERSION) {
    issues.push(issue("manifest.invalid_value", `Field "schema_version" must be "${LEGACY_SCHEMA_VERSION}".`, "$.schema_version", manifestPath));
  }
  if (legacy.kind !== LEGACY_KIND) {
    issues.push(issue("manifest.invalid_value", `Field "kind" must be "${LEGACY_KIND}".`, "$.kind", manifestPath));
  }

  if (issues.length > 0) {
    throw new ManifestValidationError(issues);
  }

  return contract;
}

function toLegacyInputs(commonInputs: string[]): SpecialistInputContract[] {
  return commonInputs.map((description, index) => ({
    name: `input_${index + 1}`,
    type: "context",
    description,
    required: true
  }));
}

function toLegacyOutputs(expectedOutputs: string[]): SpecialistOutputContract[] {
  return expectedOutputs.map((description, index) => ({
    name: `output_${index + 1}`,
    type: "artifact",
    description,
    required: true
  }));
}

function normalizeConstraints(values: string[]) {
  return values.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function extractLegacyFields(source: string) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const extracted = {
    schemaVersion: "",
    kind: "",
    metadata: {} as Record<string, string | string[]>,
    purpose: {} as Record<string, string | string[]>,
    scope: {} as Record<string, string[]>
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const rootMatch = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!rootMatch) {
      index += 1;
      continue;
    }

    const [, key, rawValue] = rootMatch;
    if (key === "schema_version") {
      extracted.schemaVersion = unquote(rawValue);
      index += 1;
      continue;
    }
    if (key === "kind") {
      extracted.kind = unquote(rawValue);
      index += 1;
      continue;
    }
    if (!["metadata", "purpose", "scope"].includes(key)) {
      index += 1;
      continue;
    }

    const section = key as "metadata" | "purpose" | "scope";
    index += 1;
    while (index < lines.length) {
      const current = lines[index];
      if (/^[^\s].*:$/.test(current) || /^[^\s].*:\s+/.test(current)) {
        break;
      }

      const fieldMatch = /^  ([a-z_]+):(?:\s+(.*))?$/.exec(current);
      if (!fieldMatch) {
        index += 1;
        continue;
      }

      const [, fieldName, fieldValue = ""] = fieldMatch;
      if (fieldValue.trim() === "|") {
        const block: string[] = [];
        index += 1;
        while (index < lines.length) {
          const blockLine = lines[index];
          if (!blockLine.startsWith("    ")) {
            break;
          }
          block.push(blockLine.slice(4));
          index += 1;
        }
        extracted[section][fieldName] = block.join("\n").trim();
        continue;
      }

      if (fieldValue.trim().length > 0) {
        extracted[section][fieldName] = unquote(fieldValue.trim());
        index += 1;
        continue;
      }

      const listItems: string[] = [];
      index += 1;
      while (index < lines.length) {
        const itemLine = lines[index];
        const itemMatch = /^    -\s+(.*)$/.exec(itemLine);
        if (!itemMatch) {
          break;
        }
        listItems.push(unquote(itemMatch[1].trim()));
        index += 1;
      }
      extracted[section][fieldName] = listItems;
    }
  }

  return extracted;
}

function unquote(value: string) {
  return value.replace(/^['"]|['"]$/g, "").trim();
}

function mapLegacyStatus(
  status: string,
  manifestPath: string,
  issues: SpecialistManifestValidationIssue[]
): SpecialistReadinessState {
  const normalized = status.trim().toLowerCase();
  if (["validated", "approved", "passed", "scored-pass"].includes(normalized)) {
    return "validated";
  }
  if (["market-ready", "ready", "deployable", "implemented"].includes(normalized)) {
    return "deployable";
  }
  if (["defined"].includes(normalized)) {
    return "definition_only";
  }
  if (["designed", "draft", "in_progress"].includes(normalized)) {
    return "partial";
  }
  if (["planned"].includes(normalized)) {
    return "planned";
  }

  issues.push(issue("manifest.enum", `Unsupported legacy metadata.status value "${status}".`, "$.metadata.status", manifestPath));
  return "definition_only";
}

function defaultStartupCheck(): SpecialistStartupCheckContract {
  return {
    id: "",
    kind: "",
    target: "",
    required: true
  };
}

function issue(
  code: SpecialistManifestValidationIssue["code"],
  message: string,
  fieldPath: string,
  manifestPath: string
): SpecialistManifestValidationIssue {
  return {
    code,
    message,
    path: fieldPath,
    manifestPath,
    line: null,
    column: null
  };
}

function isRecord(value: unknown): value is ManifestRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(
  value: ManifestRecord | null,
  key: string,
  manifestPath: string,
  issues: SpecialistManifestValidationIssue[],
  basePath = "$"
) {
  if (!value || !(key in value)) {
    issues.push(issue("manifest.required", `Missing required field "${key}".`, `${basePath}.${key}`, manifestPath));
    return null;
  }

  const candidate = value[key];
  if (!isRecord(candidate)) {
    issues.push(issue("manifest.type", `Field "${key}" must be an object.`, `${basePath}.${key}`, manifestPath));
    return null;
  }

  return candidate;
}

function readArray(
  value: ManifestRecord | null,
  key: string,
  manifestPath: string,
  issues: SpecialistManifestValidationIssue[],
  basePath = "$",
  minItems = 0
) {
  if (!value || !(key in value)) {
    issues.push(issue("manifest.required", `Missing required field "${key}".`, `${basePath}.${key}`, manifestPath));
    return [];
  }

  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    issues.push(issue("manifest.type", `Field "${key}" must be an array.`, `${basePath}.${key}`, manifestPath));
    return [];
  }

  if (candidate.length < minItems) {
    issues.push(issue("manifest.min_items", `Field "${key}" must contain at least ${minItems} item(s).`, `${basePath}.${key}`, manifestPath));
  }

  return candidate;
}

function readOptionalStringArray(
  value: ManifestRecord | null,
  key: string,
  manifestPath: string,
  issues: SpecialistManifestValidationIssue[],
  basePath = "$"
) {
  if (!value || !(key in value)) {
    return [];
  }
  return readStringArray(value, key, manifestPath, issues, basePath, 0);
}

function readStringArray(
  value: ManifestRecord | null,
  key: string,
  manifestPath: string,
  issues: SpecialistManifestValidationIssue[],
  basePath = "$",
  minItems = 0
) {
  return readArray(value, key, manifestPath, issues, basePath, minItems).flatMap((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      issues.push(issue("manifest.type", `Field "${key}" must contain non-empty strings.`, `${basePath}.${key}[${index}]`, manifestPath));
      return [];
    }
    return [entry.trim()];
  });
}

function readNonEmptyString(
  value: ManifestRecord | null,
  key: string,
  manifestPath: string,
  issues: SpecialistManifestValidationIssue[],
  basePath = "$"
) {
  if (!value || !(key in value)) {
    issues.push(issue("manifest.required", `Missing required field "${key}".`, `${basePath}.${key}`, manifestPath));
    return "";
  }

  const candidate = value[key];
  if (typeof candidate !== "string") {
    issues.push(issue("manifest.type", `Field "${key}" must be a string.`, `${basePath}.${key}`, manifestPath));
    return "";
  }

  const normalized = candidate.trim();
  if (normalized.length === 0) {
    issues.push(issue("manifest.invalid_value", `Field "${key}" must not be empty.`, `${basePath}.${key}`, manifestPath));
  }
  return normalized;
}

function readBoolean(
  value: ManifestRecord | null,
  key: string,
  manifestPath: string,
  issues: SpecialistManifestValidationIssue[],
  basePath = "$"
) {
  if (!value || !(key in value)) {
    issues.push(issue("manifest.required", `Missing required field "${key}".`, `${basePath}.${key}`, manifestPath));
    return false;
  }

  const candidate = value[key];
  if (typeof candidate !== "boolean") {
    issues.push(issue("manifest.type", `Field "${key}" must be a boolean.`, `${basePath}.${key}`, manifestPath));
    return false;
  }

  return candidate;
}

function readExpectedString(
  value: ManifestRecord,
  key: string,
  expectedValue: string,
  manifestPath: string,
  issues: SpecialistManifestValidationIssue[]
) {
  if (!(key in value)) {
    issues.push(issue("manifest.required", `Missing required field "${key}".`, `$.${key}`, manifestPath));
    return null;
  }

  const candidate = value[key];
  if (typeof candidate !== "string") {
    issues.push(issue("manifest.type", `Field "${key}" must be a string.`, `$.${key}`, manifestPath));
    return null;
  }

  if (candidate.trim() !== expectedValue) {
    issues.push(issue("manifest.invalid_value", `Field "${key}" must be "${expectedValue}".`, `$.${key}`, manifestPath));
    return null;
  }

  return expectedValue;
}

function readRawString(
  value: Record<string, string | string[]>,
  key: string,
  manifestPath: string,
  issues: SpecialistManifestValidationIssue[],
  basePath = "$"
) {
  const candidate = value[key];
  if (typeof candidate !== "string") {
    issues.push(issue("manifest.required", `Missing required field "${key}".`, `${basePath}.${key}`, manifestPath));
    return "";
  }
  if (candidate.trim().length === 0) {
    issues.push(issue("manifest.invalid_value", `Field "${key}" must not be empty.`, `${basePath}.${key}`, manifestPath));
  }
  return candidate.trim();
}

function readRawStringArray(
  value: Record<string, string | string[]>,
  key: string,
  manifestPath: string,
  issues: SpecialistManifestValidationIssue[],
  basePath = "$",
  minItems = 0
) {
  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    if (minItems > 0) {
      issues.push(issue("manifest.required", `Missing required field "${key}".`, `${basePath}.${key}`, manifestPath));
    }
    return [];
  }
  if (candidate.length < minItems) {
    issues.push(issue("manifest.min_items", `Field "${key}" must contain at least ${minItems} item(s).`, `${basePath}.${key}`, manifestPath));
  }
  return candidate.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
}

function readReadinessState(
  value: ManifestRecord,
  key: string,
  manifestPath: string,
  issues: SpecialistManifestValidationIssue[],
  basePath = "$"
) {
  const candidate = readNonEmptyString(value, key, manifestPath, issues, basePath);
  if (!READINESS_STATES.includes(candidate as SpecialistReadinessState)) {
    issues.push(issue("manifest.enum", `Field "${key}" must be one of: ${READINESS_STATES.join(", ")}.`, `${basePath}.${key}`, manifestPath));
    return null;
  }
  return candidate as SpecialistReadinessState;
}

function readNamedContracts(
  value: ManifestRecord,
  key: "inputs" | "outputs",
  manifestPath: string,
  issues: SpecialistManifestValidationIssue[],
  basePath = "$",
  requireItems = false
) {
  return readArray(value, key, manifestPath, issues, basePath, requireItems ? 1 : 0).map((entry, index) => {
    const entryPath = `${basePath}.${key}[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue("manifest.type", `Field "${key}" must contain objects.`, entryPath, manifestPath));
      return {
        name: "",
        type: "",
        description: "",
        required: false
      };
    }

    return {
      name: readNonEmptyString(entry, "name", manifestPath, issues, entryPath),
      type: readNonEmptyString(entry, "type", manifestPath, issues, entryPath),
      description: readNonEmptyString(entry, "description", manifestPath, issues, entryPath),
      required: readBoolean(entry, "required", manifestPath, issues, entryPath)
    };
  });
}
