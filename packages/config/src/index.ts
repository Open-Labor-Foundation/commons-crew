import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_PROFILE_NAMES = ["local", "test", "trusted-host"] as const;
export const FEATURE_FLAG_NAMES = ["adminOperations", "catalogSync", "evaluations"] as const;
export const ALLOWED_ENV_OVERRIDES = [
  "NODE_ENV",
  "PA_CONFIG_PROFILE",
  "PA_API_PORT",
  "PA_RUNNER_PORT",
  "PA_STORAGE_MODE",
  "PA_DATABASE_URL",
  "PA_DATABASE_SCHEMA",
  "OLF_AGENTS_ROOT",
  "PA_WORKSPACE_ROOT",
  "PA_ARTIFACTS_ROOT",
  "PA_STATE_FILE",
  "PA_BACKUPS_ROOT",
  "PA_PROVIDER_API_KEY",
  "PA_PROVIDER_BASE_URL",
  "PA_PROVIDER_MODEL",
  "PA_PROVIDER_FALLBACK_MODELS",
  "PA_SPECIALIST_EXECUTION_MODE",
  "PA_FEATURE_FLAGS",
  "PA_API_TOKEN"
] as const;

export type ConfigProfileName = (typeof CONFIG_PROFILE_NAMES)[number];
export type FeatureFlagName = (typeof FEATURE_FLAG_NAMES)[number];

export type ConfigValidationCheck = {
  name: string;
  ok: boolean;
  message: string;
};

export type AppConfig = {
  profile: {
    name: ConfigProfileName;
    source: "derived" | "environment";
    requestedName: string | null;
    error: string | null;
  };
  app: {
    name: string;
    env: string;
  };
  ports: {
    api: number;
    runner: number;
  };
  paths: {
    repoRoot: string;
    // The workspace the runtime ACTS on (reads/writes/runs commands). Defaults to
    // repoRoot (as in the container, which acts on itself), but surfaces that embed
    // the runtime — VS Code, mobile — point this at the user's project folder while
    // repoRoot stays the bundled app/governance root.
    workspaceRoot: string;
    olfAgentsRoot: string;
    artifactsRoot: string;
    stateFile: string;
    backupsRoot: string;
  };
  provider: {
    apiKey: string | null;
    baseUrl: string;
    model: string;
    // Ordered fallback models tried when the primary model returns a transient
    // error (busy / overloaded / 429 / 5xx). Empty by default.
    fallbackModels: string[];
  };
  auth: {
    apiToken: string | null;
  };
  storage: {
    mode: "memory" | "postgres";
  };
  database: {
    connectionString: string;
    schema: string;
  };
  featureFlags: Record<FeatureFlagName, boolean>;
  environment: {
    allowedOverrides: string[];
    appliedOverrides: string[];
    unknownOverrides: string[];
    featureFlagErrors: string[];
  };
};

export class ConfigValidationError extends Error {
  readonly issues: ConfigValidationCheck[];

  constructor(issues: ConfigValidationCheck[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

const FEATURE_FLAG_SET = new Set<string>(FEATURE_FLAG_NAMES);
const ALLOWED_ENV_OVERRIDE_SET = new Set<string>(ALLOWED_ENV_OVERRIDES);
const VALID_NODE_ENVS = new Set(["development", "test", "production"]);
const DEFAULT_PROVIDER_BASE_URL = "https://api.featherless.ai/v1";
const DEFAULT_PROVIDER_MODEL = "Qwen/Qwen3-32B";

function buildProfileDefaults(profile: ConfigProfileName, repoRoot: string) {
  const nodeEnvByProfile: Record<ConfigProfileName, string> = {
    local: "development",
    test: "test",
    "trusted-host": "production"
  };
  const basePaths = {
    local: {
      artifactsRoot: path.resolve(repoRoot, ".data/artifacts"),
      stateFile: path.resolve(repoRoot, ".data/state.json"),
      backupsRoot: path.resolve(repoRoot, ".data/backups")
    },
    test: {
      artifactsRoot: path.resolve(repoRoot, ".data/test/artifacts"),
      stateFile: path.resolve(repoRoot, ".data/test/state.json"),
      backupsRoot: path.resolve(repoRoot, ".data/test/backups")
    },
    "trusted-host": {
      artifactsRoot: path.resolve(repoRoot, ".data/runtime/artifacts"),
      stateFile: path.resolve(repoRoot, ".data/runtime/state.json"),
      backupsRoot: path.resolve(repoRoot, ".data/runtime/backups")
    }
  }[profile];

  return {
    env: nodeEnvByProfile[profile],
    ports: {
      api: 4000,
      runner: 4001
    },
    paths: {
      olfAgentsRoot: path.resolve(repoRoot, "../labor-commons"),
      artifactsRoot: basePaths.artifactsRoot,
      stateFile: basePaths.stateFile,
      backupsRoot: basePaths.backupsRoot
    },
    database: {
      connectionString: profile === "trusted-host" ? (process.env.PA_DATABASE_URL ?? "") : "pg-mem://commons-crew",
      schema: "pa_runtime"
    },
    storage: {
      mode: profile === "trusted-host" ? "postgres" : "memory"
    },
    featureFlags: {
      adminOperations: true,
      catalogSync: true,
      evaluations: profile !== "trusted-host"
    }
  };
}

function normalizeProfileName(profile: string | undefined): ConfigProfileName | null {
  if (!profile) {
    return null;
  }

  const normalized = profile.trim().toLowerCase().replace(/_/g, "-");
  if (CONFIG_PROFILE_NAMES.includes(normalized as ConfigProfileName)) {
    return normalized as ConfigProfileName;
  }

  return null;
}

function resolveProfile(env: NodeJS.ProcessEnv) {
  const requestedName = env.PA_CONFIG_PROFILE?.trim() || null;
  const normalizedRequestedName = normalizeProfileName(requestedName ?? undefined);

  if (normalizedRequestedName) {
    return {
      name: normalizedRequestedName,
      source: "environment" as const,
      requestedName,
      error: null
    };
  }

  if (requestedName) {
    return {
      name: inferProfileFromNodeEnv(env.NODE_ENV),
      source: "derived" as const,
      requestedName,
      error: `PA_CONFIG_PROFILE must be one of ${CONFIG_PROFILE_NAMES.join(", ")}. Received "${requestedName}".`
    };
  }

  return {
    name: inferProfileFromNodeEnv(env.NODE_ENV),
    source: "derived" as const,
    requestedName: null,
    error: null
  };
}

function inferProfileFromNodeEnv(nodeEnv: string | undefined): ConfigProfileName {
  if (nodeEnv === "test") {
    return "test";
  }
  if (nodeEnv === "production") {
    return "trusted-host";
  }
  return "local";
}

function parseBoolean(value: string) {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function parseFeatureFlagOverrides(rawValue: string | undefined) {
  const overrides: Partial<Record<FeatureFlagName, boolean>> = {};
  const errors: string[] = [];

  if (!rawValue?.trim()) {
    return { overrides, errors };
  }

  for (const token of rawValue.split(",")) {
    const entry = token.trim();
    if (!entry) {
      continue;
    }

    const [rawFlagName, rawFlagValue = "true"] = entry.split("=");
    const flagName = rawFlagName.trim();

    if (!FEATURE_FLAG_SET.has(flagName)) {
      errors.push(`Unknown feature flag "${flagName}". Allowed flags: ${FEATURE_FLAG_NAMES.join(", ")}.`);
      continue;
    }

    const parsedValue = parseBoolean(rawFlagValue);
    if (parsedValue === null) {
      errors.push(`Feature flag "${flagName}" must be set to true or false. Received "${rawFlagValue}".`);
      continue;
    }

    overrides[flagName as FeatureFlagName] = parsedValue;
  }

  return { overrides, errors };
}

function parsePort(value: string | undefined, fallback: number) {
  return value === undefined ? fallback : Number(value);
}

function isAbsolutePath(value: string) {
  return Boolean(value) && path.isAbsolute(value);
}

function moduleRepoRoot() {
  // import.meta.url is empty when this module is bundled to CJS (e.g. embedded in
  // the VS Code extension). Fall back to cwd so loadConfig never throws; embedding
  // surfaces override repoRoot explicitly anyway.
  try {
    const url = import.meta.url;
    if (!url) {
      return process.cwd();
    }
    return path.resolve(path.dirname(fileURLToPath(url)), "../../..");
  } catch {
    return process.cwd();
  }
}

function looksLikeRepoRoot(candidate: string) {
  const normalized = path.resolve(candidate);
  const hasRepoMarkers = [
    path.join(normalized, "package.json"),
    path.join(normalized, "apps"),
    path.join(normalized, "packages"),
    path.join(normalized, "governance")
  ].every((location) => existsSync(location));

  return (
    normalized.length > 1 &&
    (
      (
        (normalized.endsWith(path.sep + "commons-crew") || normalized === "commons-crew") &&
        path.basename(normalized) === "commons-crew"
      ) ||
      hasRepoMarkers
    )
  );
}

function resolveRepoRoot(env: NodeJS.ProcessEnv) {
  const candidates = [process.cwd(), env.INIT_CWD, moduleRepoRoot()].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (looksLikeRepoRoot(candidate)) {
      return path.resolve(candidate);
    }
  }
  return path.resolve(candidates[0] ?? moduleRepoRoot());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const repoRoot = resolveRepoRoot(env);
  const profile = resolveProfile(env);
  const defaults = buildProfileDefaults(profile.name, repoRoot);
  const featureFlagOverrides = parseFeatureFlagOverrides(env.PA_FEATURE_FLAGS);
  const appliedOverrides = ALLOWED_ENV_OVERRIDES.filter((name) => env[name] !== undefined);
  const unknownOverrides = Object.keys(env)
    .filter((name) => (name.startsWith("PA_") || name.startsWith("OLF_")) && !ALLOWED_ENV_OVERRIDE_SET.has(name))
    .sort();

  return {
    profile,
    app: {
      name: "commons-crew",
      env: env.NODE_ENV ?? defaults.env
    },
    ports: {
      api: parsePort(env.PA_API_PORT, defaults.ports.api),
      runner: parsePort(env.PA_RUNNER_PORT, defaults.ports.runner)
    },
    paths: {
      repoRoot,
      workspaceRoot: env.PA_WORKSPACE_ROOT ?? repoRoot,
      olfAgentsRoot: env.OLF_AGENTS_ROOT ?? defaults.paths.olfAgentsRoot,
      artifactsRoot: env.PA_ARTIFACTS_ROOT ?? defaults.paths.artifactsRoot,
      stateFile: env.PA_STATE_FILE ?? defaults.paths.stateFile,
      backupsRoot: env.PA_BACKUPS_ROOT ?? defaults.paths.backupsRoot
    },
    provider: {
      apiKey: env.PA_PROVIDER_API_KEY ?? null,
      baseUrl: env.PA_PROVIDER_BASE_URL ?? DEFAULT_PROVIDER_BASE_URL,
      model: env.PA_PROVIDER_MODEL ?? DEFAULT_PROVIDER_MODEL,
      fallbackModels: (env.PA_PROVIDER_FALLBACK_MODELS ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    },
    auth: {
      apiToken: env.PA_API_TOKEN ?? null
    },
    storage: {
      mode: (
        env.PA_STORAGE_MODE === "postgres"
          ? "postgres"
          : env.PA_STORAGE_MODE === "memory"
            ? "memory"
            : defaults.storage.mode
      ) as AppConfig["storage"]["mode"]
    },
    database: {
      connectionString: env.PA_DATABASE_URL ?? defaults.database.connectionString,
      schema: env.PA_DATABASE_SCHEMA ?? defaults.database.schema
    },
    featureFlags: {
      ...defaults.featureFlags,
      ...featureFlagOverrides.overrides
    },
    environment: {
      allowedOverrides: [...ALLOWED_ENV_OVERRIDES],
      appliedOverrides,
      unknownOverrides,
      featureFlagErrors: featureFlagOverrides.errors
    }
  };
}

export function validateConfig(config: AppConfig): ConfigValidationCheck[] {
  const expectedNodeEnv = buildProfileDefaults(config.profile.name, config.paths.repoRoot).env;

  return [
    {
      name: "config_profile",
      ok: config.profile.error === null,
      message: config.profile.error ?? `Resolved config profile "${config.profile.name}".`
    },
    {
      name: "node_env",
      ok: VALID_NODE_ENVS.has(config.app.env),
      message: VALID_NODE_ENVS.has(config.app.env)
        ? `NODE_ENV is "${config.app.env}".`
        : `NODE_ENV must be one of development, test, or production. Received "${config.app.env}".`
    },
    {
      name: "profile_environment_match",
      ok: config.app.env === expectedNodeEnv,
      message:
        config.app.env === expectedNodeEnv
          ? `Profile "${config.profile.name}" matched NODE_ENV "${config.app.env}".`
          : `Profile "${config.profile.name}" requires NODE_ENV "${expectedNodeEnv}" but resolved "${config.app.env}".`
    },
    {
      name: "pa_api_port",
      ok: Number.isInteger(config.ports.api) && config.ports.api > 0 && config.ports.api <= 65535,
      message:
        Number.isInteger(config.ports.api) && config.ports.api > 0 && config.ports.api <= 65535
          ? `PA_API_PORT resolved to ${config.ports.api}.`
          : `PA_API_PORT must resolve to an integer between 1 and 65535. Received "${config.ports.api}".`
    },
    {
      name: "pa_runner_port",
      ok: Number.isInteger(config.ports.runner) && config.ports.runner > 0 && config.ports.runner <= 65535,
      message:
        Number.isInteger(config.ports.runner) && config.ports.runner > 0 && config.ports.runner <= 65535
          ? `PA_RUNNER_PORT resolved to ${config.ports.runner}.`
          : `PA_RUNNER_PORT must resolve to an integer between 1 and 65535. Received "${config.ports.runner}".`
    },
    {
      name: "storage_mode",
      ok: config.storage.mode === "memory" || config.storage.mode === "postgres",
      message:
        config.storage.mode === "memory" || config.storage.mode === "postgres"
          ? `PA_STORAGE_MODE resolved to ${config.storage.mode}.`
          : `PA_STORAGE_MODE must resolve to "memory" or "postgres". Received "${config.storage.mode}".`
    },
    {
      name: "olf_agents_root",
      ok: isAbsolutePath(config.paths.olfAgentsRoot),
      message: isAbsolutePath(config.paths.olfAgentsRoot)
        ? `OLF_AGENTS_ROOT resolved to ${config.paths.olfAgentsRoot}.`
        : "OLF_AGENTS_ROOT must resolve to a non-empty absolute path."
    },
    {
      name: "artifacts_root",
      ok: isAbsolutePath(config.paths.artifactsRoot),
      message: isAbsolutePath(config.paths.artifactsRoot)
        ? `PA_ARTIFACTS_ROOT resolved to ${config.paths.artifactsRoot}.`
        : "PA_ARTIFACTS_ROOT must resolve to a non-empty absolute path."
    },
    {
      name: "state_file",
      ok: isAbsolutePath(config.paths.stateFile),
      message: isAbsolutePath(config.paths.stateFile)
        ? `PA_STATE_FILE resolved to ${config.paths.stateFile}.`
        : "PA_STATE_FILE must resolve to a non-empty absolute path."
    },
    {
      name: "backups_root",
      ok: isAbsolutePath(config.paths.backupsRoot),
      message: isAbsolutePath(config.paths.backupsRoot)
        ? `PA_BACKUPS_ROOT resolved to ${config.paths.backupsRoot}.`
        : "PA_BACKUPS_ROOT must resolve to a non-empty absolute path."
    },
    {
      name: "database_connection",
      ok:
        config.storage.mode === "memory" ||
        config.database.connectionString.startsWith("postgres://") ||
        config.database.connectionString.startsWith("postgresql://") ||
        config.database.connectionString.startsWith("pg-mem://"),
      message:
        config.storage.mode === "memory" ||
        config.database.connectionString.startsWith("postgres://") ||
        config.database.connectionString.startsWith("postgresql://") ||
        config.database.connectionString.startsWith("pg-mem://")
          ? `PA_DATABASE_URL resolved to ${config.database.connectionString}.`
          : `PA_DATABASE_URL must be a postgres://, postgresql://, or pg-mem:// connection string. Received "${config.database.connectionString}".`
    },
    {
      name: "database_schema",
      ok: /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(config.database.schema),
      message: /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(config.database.schema)
        ? `PA_DATABASE_SCHEMA resolved to ${config.database.schema}.`
        : `PA_DATABASE_SCHEMA must be a valid SQL identifier. Received "${config.database.schema}".`
    },
    {
      name: "provider_api_key",
      ok: config.profile.name !== "trusted-host" || Boolean(config.provider.apiKey),
      message: config.provider.apiKey
        ? `PA_PROVIDER_API_KEY is configured (${config.provider.baseUrl}).`
        : config.profile.name === "trusted-host"
          ? "PA_PROVIDER_API_KEY is required for trusted-host profile."
          : "PA_PROVIDER_API_KEY is not set; provider calls will fail at runtime."
    },
    {
      name: "api_token",
      ok: config.profile.name !== "trusted-host" || Boolean(config.auth.apiToken),
      message: config.auth.apiToken
        ? "PA_API_TOKEN is configured; API requests must present it as a bearer token."
        : config.profile.name === "trusted-host"
          ? "PA_API_TOKEN is required for trusted-host profile."
          : "PA_API_TOKEN is not set; the API will accept unauthenticated requests."
    },
    {
      name: "feature_flag_overrides",
      ok: config.environment.featureFlagErrors.length === 0,
      message:
        config.environment.featureFlagErrors.length === 0
          ? "Feature flag overrides parsed successfully."
          : config.environment.featureFlagErrors.join(" ")
    },
    {
      name: "environment_override_governance",
      ok: config.environment.unknownOverrides.length === 0,
      message:
        config.environment.unknownOverrides.length === 0
          ? "Only allowed environment overrides are in use."
          : `Unsupported environment override(s): ${config.environment.unknownOverrides.join(", ")}.`
    }
  ];
}

export function loadConfigOrThrow(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const issues = validateConfig(config).filter((entry) => !entry.ok);
  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }
  return config;
}
