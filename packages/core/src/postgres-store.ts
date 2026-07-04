import { newDb } from "pg-mem";
import { Pool } from "pg";
import type { AppConfig } from "../../config/src/index";
import type { PersistentState } from "../../contracts/src/index";
import type { StateStore } from "./persistence";

export type QueryResultRow = Record<string, unknown>;
export type SqlQueryable = {
  query<TResult extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: TResult[] }>;
};
export type SqlClient = SqlQueryable & {
  release?: () => void;
};
export type SqlPool = SqlQueryable & {
  connect(): Promise<SqlClient>;
  end(): Promise<void>;
};

type RuntimeStateRow = {
  payload: PersistentState;
  state_key: string;
};

type PersistedEntityRow = {
  payload: Record<string, unknown>;
};

type StateCollectionKey = keyof Omit<PersistentState, "workspace" | "promptGovernance">;

type PersistenceCollection = {
  key: StateCollectionKey;
  table: string;
};

const ENTITY_COLLECTIONS: readonly PersistenceCollection[] = [
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

const pgMemDatabases = new Map<string, ReturnType<typeof newDb>>();
const postgresWriteLocks = new Map<string, Promise<void>>();
const RUNTIME_SCHEMA_MIGRATIONS = [
  "0001_runtime_foundation",
  "0002_runtime_indexes",
  "0003_runtime_entities",
  "0004_runtime_entity_indexes"
] as const;
const ORDERED_SCHEMA_MIGRATIONS = [
  {
    key: "0001_runtime_foundation",
    statements: (schemaName: string) => [
      `
        CREATE TABLE IF NOT EXISTS ${schemaName}.runtime_state (
          state_key text,
          payload jsonb,
          updated_at timestamptz
        )
      `
    ]
  },
  {
    key: "0002_runtime_indexes",
    statements: (schemaName: string) => [
      `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${ensureIdentifier(schemaName.replace(/"/g, ""), "schema")}_runtime_state_key_idx`)} ON ${schemaName}.runtime_state (state_key)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${ensureIdentifier(schemaName.replace(/"/g, ""), "schema")}_schema_migrations_key_idx`)} ON ${schemaName}.schema_migrations (migration_key)`
    ]
  },
  {
    key: "0003_runtime_entities",
    statements: (schemaName: string) =>
      ENTITY_COLLECTIONS.map(
        (collection) => `
          CREATE TABLE IF NOT EXISTS ${schemaName}.${quoteIdentifier(collection.table)} (
            id text,
            payload jsonb,
            updated_at timestamptz
          )
        `
      )
  },
  {
    key: "0004_runtime_entity_indexes",
    statements: (schemaName: string) =>
      ENTITY_COLLECTIONS.map(
        (collection) =>
          `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${collection.table}_id_idx`)} ON ${schemaName}.${quoteIdentifier(collection.table)} (id)`
      )
  }
] as const;

export function ensureIdentifier(value: string, label: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

export function quoteIdentifier(value: string) {
  return `"${value}"`;
}

export function createSqlPool(connectionString: string): SqlPool {
  if (connectionString.startsWith("pg-mem://")) {
    const existing = pgMemDatabases.get(connectionString);
    const database = existing ?? newDb();
    if (!existing) {
      pgMemDatabases.set(connectionString, database);
    }
    const adapter = database.adapters.createPg();
    return new adapter.Pool() as SqlPool;
  }

  return new Pool({ connectionString });
}

function mergeWithDefaults(defaults: PersistentState, state: Partial<PersistentState> | null | undefined): PersistentState {
  return {
    ...defaults,
    ...state,
    workspace: state?.workspace ?? defaults.workspace,
    users: state?.users ?? defaults.users,
    workspaceMemberships: state?.workspaceMemberships ?? defaults.workspaceMemberships,
    promptGovernance: {
      ...defaults.promptGovernance,
      ...(state?.promptGovernance ?? {})
    },
    providerProfiles: state?.providerProfiles ?? [],
    providerCapabilitySnapshots: state?.providerCapabilitySnapshots ?? [],
    configProfiles: state?.configProfiles ?? [],
    featureFlags: state?.featureFlags ?? [],
    promptSpecs: state?.promptSpecs ?? [],
    sessions: state?.sessions ?? [],
    messages: state?.messages ?? [],
    clarifications: state?.clarifications ?? [],
    workItems: state?.workItems ?? [],
    workItemCollaborationThreads: state?.workItemCollaborationThreads ?? [],
    workItemCollaborationMessages: state?.workItemCollaborationMessages ?? [],
    requests: state?.requests ?? [],
    plans: state?.plans ?? [],
    planSteps: state?.planSteps ?? [],
    planChangeRequests: state?.planChangeRequests ?? [],
    clarificationThreads: state?.clarificationThreads ?? [],
    clarificationMessages: state?.clarificationMessages ?? [],
    runs: state?.runs ?? [],
    tasks: state?.tasks ?? [],
    taskPlanLinks: state?.taskPlanLinks ?? [],
    delegationDecisions: state?.delegationDecisions ?? [],
    catalogEntries: state?.catalogEntries ?? [],
    catalogSyncs: state?.catalogSyncs ?? [],
    materializations: state?.materializations ?? [],
    runnerJobs: state?.runnerJobs ?? [],
    approvals: state?.approvals ?? [],
    actionProposals: state?.actionProposals ?? [],
    actionExecutions: state?.actionExecutions ?? [],
    artifacts: state?.artifacts ?? [],
    runEvents: state?.runEvents ?? [],
    evaluationRuns: state?.evaluationRuns ?? [],
    incidents: state?.incidents ?? [],
    migrationRecords: state?.migrationRecords ?? []
  };
}

function isEntityArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value);
}

export class PostgresStateStore implements StateStore {
  readonly kind = "postgres" as const;

  private readonly pool: SqlPool;
  private readonly schema: string;
  private writeChain = Promise.resolve();
  private readonly writeLockKey: string;

  constructor(
    config: AppConfig,
    private readonly defaults: PersistentState
  ) {
    this.pool = createSqlPool(config.database.connectionString);
    this.schema = ensureIdentifier(config.database.schema, "Postgres schema");
    this.writeLockKey = `${config.database.connectionString}::${this.schema}`;
  }

  async init() {
    await this.ensureSchemaObjects();
    await this.backfillEntityCollectionsFromRuntimeState();
  }

  async read(): Promise<PersistentState> {
    await this.init();
    return this.readFrom(this.pool);
  }

  async write(mutator: (state: PersistentState) => PersistentState | Promise<PersistentState>) {
    const previousWrite = Promise.all([
      this.writeChain.catch(() => undefined),
      (postgresWriteLocks.get(this.writeLockKey) ?? Promise.resolve()).catch(() => undefined)
    ]);
    const nextWrite = previousWrite.then(async () => {
      await this.init();
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await this.acquireWriteLock(client);
        const current = await this.readFrom(client);
        const next = await mutator(current);
        const now = new Date().toISOString();
        await this.writeRuntimeState(client, next, now);
        await this.writeCollections(client, next, now);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release?.();
      }
    });
    this.writeChain = nextWrite;
    postgresWriteLocks.set(this.writeLockKey, nextWrite);

    try {
      await nextWrite;
    } finally {
      if (postgresWriteLocks.get(this.writeLockKey) === nextWrite) {
        postgresWriteLocks.delete(this.writeLockKey);
      }
    }
  }

  async flush() {
    await this.writeChain;
  }

  async close() {
    await this.writeChain;
    await this.pool.end();
  }

  private async acquireWriteLock(queryable: SqlQueryable) {
    const schemaName = quoteIdentifier(this.schema);
    await queryable.query(
      `UPDATE ${schemaName}.runtime_state
       SET updated_at = updated_at
       WHERE state_key = $1`,
      ["primary"]
    );
  }

  private async ensureSchemaObjects() {
    const schemaName = quoteIdentifier(this.schema);
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${schemaName}.schema_migrations (
        id text,
        migration_key text,
        applied_at timestamptz,
        applied_by text,
        status text
      )
    `);
    await this.applySchemaMigrations();

    const existing = await this.pool.query<{ state_key: string }>(
      `SELECT state_key FROM ${schemaName}.runtime_state WHERE state_key = $1 LIMIT 1`,
      ["primary"]
    );
    if (existing.rows.length === 0) {
      await this.pool.query(
        `INSERT INTO ${schemaName}.runtime_state (state_key, payload, updated_at) VALUES ($1, $2::jsonb, $3)`,
        ["primary", JSON.stringify({}), new Date().toISOString()]
      );
    }
  }

  private async applySchemaMigrations() {
    const schemaName = quoteIdentifier(this.schema);
    const existingRows = await this.pool.query<{ migration_key: string }>(
      `SELECT migration_key FROM ${schemaName}.schema_migrations ORDER BY applied_at ASC, migration_key ASC`
    );
    const appliedKeys = new Set(existingRows.rows.map((row) => row.migration_key));

    for (const migration of ORDERED_SCHEMA_MIGRATIONS) {
      if (appliedKeys.has(migration.key)) {
        continue;
      }

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        for (const statement of migration.statements(schemaName)) {
          await client.query(statement);
        }
        const appliedAt = new Date().toISOString();
        await client.query(
          `INSERT INTO ${schemaName}.schema_migrations (id, migration_key, applied_at, applied_by, status) VALUES ($1, $2, $3::timestamptz, $4, $5)`,
          [`migration-record:${migration.key}`, migration.key, appliedAt, "system_bootstrap", "applied"]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release?.();
      }
    }
  }

  private async backfillEntityCollectionsFromRuntimeState() {
    const schemaName = quoteIdentifier(this.schema);
    const hasEntities = await this.hasAnyEntityRows();
    const runtimeState = await this.readRuntimeState(this.pool);
    if (!hasEntities && runtimeState) {
      await this.writeCollections(this.pool, mergeWithDefaults(this.defaults, runtimeState), new Date().toISOString());
      await this.pool.query(`UPDATE ${schemaName}.runtime_state SET updated_at = NOW() WHERE state_key = $1`, ["primary"]);
    }
  }

  private async hasAnyEntityRows() {
    const schemaName = quoteIdentifier(this.schema);
    for (const collection of ENTITY_COLLECTIONS) {
      try {
        const result = await this.pool.query<{ exists: boolean | number | string }>(
          `SELECT EXISTS (SELECT 1 FROM ${schemaName}.${quoteIdentifier(collection.table)} LIMIT 1)`,
          []
        );
        if (result.rows[0]?.exists) {
          return true;
        }
      } catch (error) {
        if (error instanceof Error && /does not exist/i.test(error.message)) {
          return false;
        }
        throw error;
      }
    }
    return false;
  }

  private async readFrom(queryable: SqlQueryable): Promise<PersistentState> {
    const runtimeState = await this.readRuntimeState(queryable);
    const collections = await this.readCollections(queryable);
    const hasCollectionRows = ENTITY_COLLECTIONS.some((entry) => {
      const values = collections[entry.key];
      return isEntityArray(values) && values.length > 0;
    });

    if (!hasCollectionRows && runtimeState) {
      const mergedState = mergeWithDefaults(this.defaults, runtimeState);
      await this.writeCollections(queryable, mergedState, new Date().toISOString());
      return mergedState;
    }

    if (!hasCollectionRows) {
      return runtimeState ? mergeWithDefaults(this.defaults, runtimeState) : mergeWithDefaults(this.defaults, undefined);
    }

    return mergeWithDefaults(this.defaults, {
      ...(runtimeState ?? {}),
      ...collections
    });
  }

  private async readCollections(queryable: SqlQueryable) {
    const result: Partial<PersistentState> = {};

    for (const collection of ENTITY_COLLECTIONS) {
      const payloads = await this.readCollection(queryable, collection.table);
      (result as Partial<PersistentState>)[collection.key] = payloads as never;
    }

    return result;
  }

  private async readCollection<T>(queryable: SqlQueryable, table: string): Promise<T[]> {
    const schemaName = quoteIdentifier(this.schema);
    const result = await queryable.query<PersistedEntityRow & { payload: T }>(
      `SELECT payload FROM ${schemaName}.${quoteIdentifier(table)} ORDER BY id ASC`
    );
    return result.rows.map((entry) => entry.payload as T);
  }

  private async readRuntimeState(queryable: SqlQueryable): Promise<PersistentState | null> {
    const schemaName = quoteIdentifier(this.schema);
    const result = await queryable.query<RuntimeStateRow>(
      `SELECT state_key, payload FROM ${schemaName}.runtime_state WHERE state_key = $1 LIMIT 1`,
      ["primary"]
    );
    return result.rows[0]?.payload ?? null;
  }

  private async writeRuntimeState(queryable: SqlQueryable, state: PersistentState, timestamp: string) {
    const schemaName = quoteIdentifier(this.schema);
    try {
      await queryable.query(
        `INSERT INTO ${schemaName}.runtime_state (state_key, payload, updated_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (state_key)
         DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
        ["primary", JSON.stringify(state), timestamp]
      );
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/no unique or exclusion constraint matching the ON CONFLICT specification/i.test(error.message)) {
        throw error;
      }
    }

    const current = await queryable.query<{ state_key: string }>(
      `SELECT state_key FROM ${schemaName}.runtime_state WHERE state_key = $1 LIMIT 1`,
      ["primary"]
    );
    if (current.rows.length > 0) {
      await queryable.query(
        `UPDATE ${schemaName}.runtime_state SET payload = $1::jsonb, updated_at = $2 WHERE state_key = $3`,
        [JSON.stringify(state), timestamp, "primary"]
      );
      return;
    }

    await queryable.query(
      `INSERT INTO ${schemaName}.runtime_state (state_key, payload, updated_at) VALUES ($1, $2::jsonb, $3)`,
      ["primary", JSON.stringify(state), timestamp]
    );
  }

  private async writeCollections(queryable: SqlQueryable, state: PersistentState, timestamp: string) {
    for (const collection of ENTITY_COLLECTIONS) {
      await this.writeCollection(queryable, collection.table, state[collection.key] as Array<{ id: string }>, timestamp);
    }
  }

  private async writeCollection(
    queryable: SqlQueryable,
    table: string,
    records: Array<{ id: string }>,
    timestamp: string
  ) {
    const schemaName = quoteIdentifier(this.schema);
    await queryable.query(`DELETE FROM ${schemaName}.${quoteIdentifier(table)}`);
    for (const record of records) {
      await queryable.query(
        `INSERT INTO ${schemaName}.${quoteIdentifier(table)} (id, payload, updated_at)
         VALUES ($1, $2::jsonb, $3)`,
        [record.id, JSON.stringify(record), timestamp]
      );
    }
  }
}
