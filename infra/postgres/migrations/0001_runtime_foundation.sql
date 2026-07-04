CREATE SCHEMA IF NOT EXISTS pa_runtime;

CREATE TABLE IF NOT EXISTS pa_runtime.schema_migrations (
  migration_key TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pa_runtime.runtime_state (
  state_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO pa_runtime.runtime_state (state_key, payload)
VALUES ('primary', '{}'::jsonb)
ON CONFLICT (state_key) DO NOTHING;
