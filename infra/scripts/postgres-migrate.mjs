import { promises as fs } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { loadConfigOrThrow } from "../../packages/config/src/index.js";

const config = loadConfigOrThrow();

if (config.storage.mode !== "postgres") {
  console.error("PA_STORAGE_MODE must be set to postgres before running migrations.");
  process.exit(1);
}

const migrationsRoot = path.resolve(process.cwd(), "infra/postgres/migrations");
const migrationFiles = (await fs.readdir(migrationsRoot))
  .filter((entry) => entry.endsWith(".sql"))
  .sort();

const pool = new Pool({ connectionString: config.database.connectionString });

try {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${config.database.schema}"`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${config.database.schema}".schema_migrations (
      migration_key text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  for (const file of migrationFiles) {
    const key = file.replace(/\.sql$/, "");
    const existing = await pool.query(
      `SELECT migration_key FROM "${config.database.schema}".schema_migrations WHERE migration_key = $1`,
      [key]
    );
    if (existing.rows.length > 0) {
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsRoot, file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql.replaceAll("pa_runtime", config.database.schema));
      await pool.query(
        `INSERT INTO "${config.database.schema}".schema_migrations (migration_key) VALUES ($1)`,
        [key]
      );
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await pool.end();
}
