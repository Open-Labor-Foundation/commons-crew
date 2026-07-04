CREATE INDEX IF NOT EXISTS runtime_state_updated_at_idx
  ON pa_runtime.runtime_state (updated_at DESC);
