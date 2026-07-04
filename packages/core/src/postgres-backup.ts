import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../../config/src/index";
import type { PersistentState } from "../../contracts/src/index";
import { createSqlPool, ensureIdentifier, quoteIdentifier, type SqlPool } from "./postgres-store";

const schemaToken = "__PA_RUNTIME_SCHEMA__";

type BackupCounts = {
  users: number;
  workspaceMemberships: number;
  providerProfiles: number;
  providerCapabilitySnapshots: number;
  configProfiles: number;
  featureFlags: number;
  promptSpecs: number;
  sessions: number;
  messages: number;
  clarifications: number;
  workItems: number;
  workItemCollaborationThreads: number;
  workItemCollaborationMessages: number;
  requests: number;
  plans: number;
  planSteps: number;
  planChangeRequests: number;
  clarificationThreads: number;
  clarificationMessages: number;
  runs: number;
  tasks: number;
  taskPlanLinks: number;
  delegationDecisions: number;
  catalogEntries: number;
  catalogSyncs: number;
  materializations: number;
  runnerJobs: number;
  approvals: number;
  actionProposals: number;
  actionExecutions: number;
  artifacts: number;
  runEvents: number;
  evaluationRuns: number;
  incidents: number;
  migrationRecords: number;
};

type EntityCollection = {
  key: Exclude<keyof PersistentState, "workspace" | "promptGovernance">;
  table: string;
};

const BACKUP_ENTITIES: readonly EntityCollection[] = [
  { key: "users", table: "users" },
  { key: "workspaceMemberships", table: "workspace_memberships" },
  { key: "providerProfiles", table: "provider_profiles" },
  { key: "providerCapabilitySnapshots", table: "provider_capability_snapshots" },
  { key: "configProfiles", table: "config_profiles" },
  { key: "featureFlags", table: "feature_flags" },
  { key: "promptSpecs", table: "prompt_specs" },
  { key: "sessions", table: "sessions" },
  { key: "messages", table: "messages" },
  { key: "clarifications", table: "clarifications" },
  { key: "workItems", table: "work_items" },
  { key: "workItemCollaborationThreads", table: "work_item_collaboration_threads" },
  { key: "workItemCollaborationMessages", table: "work_item_collaboration_messages" },
  { key: "requests", table: "requests" },
  { key: "plans", table: "plans" },
  { key: "planSteps", table: "plan_steps" },
  { key: "planChangeRequests", table: "plan_change_requests" },
  { key: "clarificationThreads", table: "clarification_threads" },
  { key: "clarificationMessages", table: "clarification_messages" },
  { key: "runs", table: "runs" },
  { key: "tasks", table: "tasks" },
  { key: "taskPlanLinks", table: "task_plan_links" },
  { key: "delegationDecisions", table: "delegation_decisions" },
  { key: "catalogEntries", table: "catalog_entries" },
  { key: "catalogSyncs", table: "catalog_syncs" },
  { key: "materializations", table: "materializations" },
  { key: "runnerJobs", table: "runner_jobs" },
  { key: "approvals", table: "approvals" },
  { key: "actionProposals", table: "action_proposals" },
  { key: "actionExecutions", table: "action_executions" },
  { key: "artifacts", table: "artifacts" },
  { key: "runEvents", table: "run_events" },
  { key: "evaluationRuns", table: "evaluation_runs" },
  { key: "incidents", table: "incidents" },
  { key: "migrationRecords", table: "migration_records" }
] as const;

export type PostgresBackupResult = {
  backupPath: string;
  backupCapturedAt: string;
  backupEvidencePath: string;
  counts: BackupCounts;
};

type LoadedBackup = {
  state: PersistentState;
  result: PostgresBackupResult;
};

export type PostgresBackupVerification = PostgresBackupResult & {
  ok: true;
  restoreVerified: true;
  restoreSchema: string;
  restoreEvidencePath: string;
  drillEvidencePath: string;
  verifiedAt: string;
};

type RestorePostgresBackupOptions = {
  evidenceRoot?: string;
  restoredAt?: string;
  restoreSource?: "manual" | "verification";
};

type BackupEvidence = {
  kind: "postgres_backup";
  backupPath: string;
  capturedAt: string;
  counts: BackupCounts;
};

type RestoreEvidence = {
  kind: "postgres_restore";
  backupPath: string;
  schema: string;
  restoredAt: string;
  restoreSource: "manual" | "verification";
};

type DisasterDrillEvidence = {
  kind: "postgres_disaster_drill";
  backupPath: string;
  backupEvidencePath: string;
  restoreEvidencePath: string;
  restoreSchema: string;
  counts: BackupCounts;
  verifiedAt: string;
};

export type BackupVerificationEvidence = {
  schemaVersion: "backup_verification.v1";
  verifiedAt: string;
  storageMode: "postgres" | "memory";
  ok: true;
  restoreVerified: boolean;
  backupPath: string;
  evidencePath: string;
  restoreSchema: string | null;
  sourceSchema: string | null;
  counts?: BackupCounts;
};

type RuntimeStateRow = {
  payload: PersistentState;
};

function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function writeEvidenceFile<T>(filePath: string, payload: T) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function buildCounts(state: PersistentState): BackupCounts {
  return {
    users: state.users.length,
    workspaceMemberships: state.workspaceMemberships.length,
    providerProfiles: state.providerProfiles.length,
    providerCapabilitySnapshots: state.providerCapabilitySnapshots.length,
    configProfiles: state.configProfiles.length,
    featureFlags: state.featureFlags.length,
    promptSpecs: state.promptSpecs.length,
    sessions: state.sessions.length,
    messages: state.messages.length,
    clarifications: state.clarifications.length,
    workItems: state.workItems.length,
    workItemCollaborationThreads: state.workItemCollaborationThreads.length,
    workItemCollaborationMessages: state.workItemCollaborationMessages.length,
    requests: state.requests.length,
    plans: state.plans.length,
    planSteps: state.planSteps.length,
    planChangeRequests: state.planChangeRequests.length,
    clarificationThreads: state.clarificationThreads.length,
    clarificationMessages: state.clarificationMessages.length,
    runs: state.runs.length,
    tasks: state.tasks.length,
    taskPlanLinks: state.taskPlanLinks.length,
    delegationDecisions: state.delegationDecisions.length,
    catalogEntries: state.catalogEntries.length,
    catalogSyncs: state.catalogSyncs.length,
    materializations: state.materializations.length,
    runnerJobs: state.runnerJobs.length,
    approvals: state.approvals.length,
    actionProposals: state.actionProposals.length,
    actionExecutions: state.actionExecutions.length,
    artifacts: state.artifacts.length,
    runEvents: state.runEvents.length,
    evaluationRuns: state.evaluationRuns.length,
    incidents: state.incidents.length,
    migrationRecords: state.migrationRecords.length
  };
}

function normalizeStateForComparison(state: PersistentState | null) {
  if (!state) {
    return state;
  }

  const sortRecords = <T>(records: T[]) =>
    [...records].sort((left, right) => {
      const leftKey = isRecordWithId(left)
        ? left.id
        : typeof left === "object" && left !== null && "createdAt" in left && typeof (left as { createdAt?: unknown }).createdAt === "string"
          ? (left as { createdAt: string }).createdAt
          : JSON.stringify(left);
      const rightKey = isRecordWithId(right)
        ? right.id
        : typeof right === "object" && right !== null && "createdAt" in right && typeof (right as { createdAt?: unknown }).createdAt === "string"
          ? (right as { createdAt: string }).createdAt
          : JSON.stringify(right);
      return leftKey.localeCompare(rightKey);
    });

  return {
    ...state,
    users: sortRecords(state.users),
    workspaceMemberships: sortRecords(state.workspaceMemberships),
    providerProfiles: sortRecords(state.providerProfiles),
    providerCapabilitySnapshots: sortRecords(state.providerCapabilitySnapshots),
    configProfiles: sortRecords(state.configProfiles),
    featureFlags: sortRecords(state.featureFlags),
    promptSpecs: sortRecords(state.promptSpecs),
    sessions: sortRecords(state.sessions),
    messages: sortRecords(state.messages),
    clarifications: sortRecords(state.clarifications),
    workItems: sortRecords(state.workItems),
    workItemCollaborationThreads: sortRecords(state.workItemCollaborationThreads),
    workItemCollaborationMessages: sortRecords(state.workItemCollaborationMessages),
    requests: sortRecords(state.requests),
    plans: sortRecords(state.plans),
    planSteps: sortRecords(state.planSteps),
    planChangeRequests: sortRecords(state.planChangeRequests),
    clarificationThreads: sortRecords(state.clarificationThreads),
    clarificationMessages: sortRecords(state.clarificationMessages),
    runs: sortRecords(state.runs),
    tasks: sortRecords(state.tasks),
    taskPlanLinks: sortRecords(state.taskPlanLinks),
    delegationDecisions: sortRecords(state.delegationDecisions),
    catalogEntries: sortRecords(state.catalogEntries),
    catalogSyncs: sortRecords(state.catalogSyncs),
    materializations: sortRecords(state.materializations),
    runnerJobs: sortRecords(state.runnerJobs),
    approvals: sortRecords(state.approvals),
    actionProposals: sortRecords(state.actionProposals),
    actionExecutions: sortRecords(state.actionExecutions),
    artifacts: sortRecords(state.artifacts),
    runEvents: sortRecords(state.runEvents),
    evaluationRuns: sortRecords(state.evaluationRuns),
    incidents: sortRecords(state.incidents),
    migrationRecords: sortRecords(state.migrationRecords)
  };
}

function isRecordWithId(value: unknown): value is { id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as { id: unknown }).id === "string"
  );
}

function buildMigrationRows(schema: string, timestamp: string) {
  const migrationKeys = [
    "0001_runtime_foundation",
    "0002_runtime_indexes",
    "0003_runtime_entities",
    "0004_runtime_entity_indexes"
  ];
  return [
    `CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (migration_key text, applied_at timestamptz);`,
    `ALTER TABLE ${schema}.schema_migrations ADD COLUMN IF NOT EXISTS id text;`,
    `ALTER TABLE ${schema}.schema_migrations ADD COLUMN IF NOT EXISTS applied_by text;`,
    `ALTER TABLE ${schema}.schema_migrations ADD COLUMN IF NOT EXISTS status text;`,
    `DELETE FROM ${schema}.schema_migrations;`,
    ...migrationKeys.map(
      (key) =>
        `INSERT INTO ${schema}.schema_migrations (id, migration_key, applied_at, applied_by, status) VALUES (${sqlLiteral(`migration-record:${key}`)}, ${sqlLiteral(key)}, ${sqlLiteral(timestamp)}::timestamptz, ${sqlLiteral("system_bootstrap")}, ${sqlLiteral("applied")});`
    )
  ];
}

function buildEntityCollectionSql(state: PersistentState, timestamp: string) {
  const statements: string[] = [];
  for (const collection of BACKUP_ENTITIES) {
    const schemaTable = `${quoteIdentifier(schemaToken)}.${quoteIdentifier(collection.table)}`;
    const records = state[collection.key].filter(isRecordWithId);
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${schemaTable} (id text, payload jsonb, updated_at timestamptz);`
    );
    statements.push(`DELETE FROM ${schemaTable};`);
    for (const record of records) {
      statements.push(
        `INSERT INTO ${schemaTable} (id, payload, updated_at) VALUES (${sqlLiteral(record.id)}, ${sqlLiteral(
          JSON.stringify(record)
        )}::jsonb, ${sqlLiteral(timestamp)}::timestamptz);`
      );
    }
  }
  return statements;
}

function buildBackupSql(state: PersistentState) {
  const timestamp = new Date().toISOString();
  return [
    "BEGIN;",
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaToken)};`,
    ...buildMigrationRows(quoteIdentifier(schemaToken), timestamp),
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(schemaToken)}.runtime_state (state_key text, payload jsonb, updated_at timestamptz);`,
    `DELETE FROM ${quoteIdentifier(schemaToken)}.runtime_state WHERE state_key = ${sqlLiteral("primary")};`,
    `INSERT INTO ${quoteIdentifier(schemaToken)}.runtime_state (state_key, payload, updated_at) VALUES (${sqlLiteral("primary")}, ${sqlLiteral(JSON.stringify(state))}::jsonb, ${sqlLiteral(timestamp)}::timestamptz);`,
    ...buildEntityCollectionSql(state, timestamp),
    "COMMIT;"
  ].join("\n");
}

function applySchema(sql: string, schema: string) {
  const safeSchema = ensureIdentifier(schema, "Postgres schema");
  return sql.replaceAll(quoteIdentifier(schemaToken), quoteIdentifier(safeSchema));
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function loadPrimaryState(pool: SqlPool, schema: string) {
  const safeSchema = quoteIdentifier(ensureIdentifier(schema, "Postgres schema"));
  const result = await pool.query<RuntimeStateRow>(
    `SELECT payload FROM ${safeSchema}.runtime_state WHERE state_key = $1 LIMIT 1`,
    ["primary"]
  );
  return result.rows[0]?.payload ?? null;
}

async function dropSchema(connectionString: string, schema: string) {
  if (connectionString.startsWith("pg-mem://")) {
    return;
  }

  const pool = createSqlPool(connectionString);
  try {
    try {
      await pool.query(`DROP SCHEMA ${quoteIdentifier(ensureIdentifier(schema, "Postgres schema"))} CASCADE`);
    } catch (error) {
      if (!(error instanceof Error) || !/does not exist/i.test(error.message)) {
        throw error;
      }
    }
  } finally {
    await pool.end();
  }
}

async function loadBackupState(config: AppConfig, outputPath?: string): Promise<LoadedBackup> {
  const backupPath = outputPath ?? path.join(config.paths.backupsRoot, `postgres-runtime-${Date.now()}.sql`);
  const pool = createSqlPool(config.database.connectionString);

  try {
    const state = await loadPrimaryState(pool, config.database.schema);
    if (!state) {
      throw new Error("No Postgres runtime state was found for backup.");
    }

    const backupCapturedAt = new Date().toISOString();
    const counts = buildCounts(state);
    const backupEvidencePath = path.join(
      config.paths.backupsRoot,
      `postgres-backup-evidence-${backupCapturedAt.replaceAll(":", "-")}.json`
    );

    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.writeFile(backupPath, buildBackupSql(state));
    await writeEvidenceFile<BackupEvidence>(backupEvidencePath, {
      kind: "postgres_backup",
      backupPath,
      capturedAt: backupCapturedAt,
      counts
    });

    return {
      state,
      result: {
        backupPath,
        backupCapturedAt,
        backupEvidencePath,
        counts
      }
    };
  } finally {
    await pool.end();
  }
}

function createBackupVerificationEvidencePath(config: AppConfig, verifiedAt: string) {
  const stamp = verifiedAt.replace(/[:.]/g, "-");
  return path.join(config.paths.artifactsRoot, "recovery", "backup-drills", `${stamp}.json`);
}

export async function writeBackupVerificationEvidence(
  config: AppConfig,
  evidence: Omit<BackupVerificationEvidence, "evidencePath">
): Promise<string> {
  const evidencePath = createBackupVerificationEvidencePath(config, evidence.verifiedAt);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(
    evidencePath,
    `${JSON.stringify({ ...evidence, evidencePath }, null, 2)}\n`
  );
  return evidencePath;
}

export async function writePostgresBackup(config: AppConfig, outputPath?: string): Promise<PostgresBackupResult> {
  return (await loadBackupState(config, outputPath)).result;
}

export async function restorePostgresBackup(
  connectionString: string,
  schema: string,
  backupPath: string,
  options: RestorePostgresBackupOptions = {}
) {
  const sql = applySchema(await fs.readFile(backupPath, "utf8"), schema);
  const pool = createSqlPool(connectionString);
  const restoredAt = options.restoredAt ?? new Date().toISOString();
  const evidenceRoot = options.evidenceRoot ?? path.dirname(backupPath);
  const restoreEvidencePath = path.join(
    evidenceRoot,
    `postgres-restore-evidence-${restoredAt.replaceAll(":", "-")}.json`
  );
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }

  await writeEvidenceFile<RestoreEvidence>(restoreEvidencePath, {
    kind: "postgres_restore",
    backupPath,
    schema,
    restoredAt,
    restoreSource: options.restoreSource ?? "manual"
  });

  return {
    backupPath,
    restoreEvidencePath,
    restoredAt,
    schema
  };
}

export async function verifyPostgresBackup(config: AppConfig, expectedState: PersistentState): Promise<PostgresBackupVerification> {
  const { state: backupState, result: backup } = await loadBackupState(config);
  const restoreSchema = `${config.database.schema}_restore_verify_${Date.now().toString(36)}`;
  const verifiedAt = new Date().toISOString();
  let restoreEvidencePath = path.join(
    config.paths.backupsRoot,
    `postgres-restore-evidence-${verifiedAt.replaceAll(":", "-")}.json`
  );

  try {
    const restore = await restorePostgresBackup(config.database.connectionString, restoreSchema, backup.backupPath, {
      evidenceRoot: config.paths.backupsRoot,
      restoredAt: verifiedAt,
      restoreSource: "verification"
    });
    restoreEvidencePath = restore.restoreEvidencePath;
    const pool = createSqlPool(config.database.connectionString);
    try {
      const restoredState = await loadPrimaryState(pool, restoreSchema);
      if (JSON.stringify(normalizeStateForComparison(restoredState)) !== JSON.stringify(normalizeStateForComparison(expectedState))) {
        throw new Error("Backup verification restore did not match the source runtime state.");
      }
    } finally {
      await pool.end();
    }
  } finally {
    await dropSchema(config.database.connectionString, restoreSchema);
  }

  const drillEvidencePath = path.join(
    config.paths.backupsRoot,
    `postgres-disaster-drill-${verifiedAt.replaceAll(":", "-")}.json`
  );
  await writeEvidenceFile<DisasterDrillEvidence>(drillEvidencePath, {
    kind: "postgres_disaster_drill",
    backupPath: backup.backupPath,
    backupEvidencePath: backup.backupEvidencePath,
    restoreEvidencePath,
    restoreSchema,
    counts: backup.counts,
    verifiedAt
  });

  return {
    ok: true,
    restoreVerified: true,
    restoreSchema,
    restoreEvidencePath,
    drillEvidencePath,
    verifiedAt,
    ...backup
  };
}
