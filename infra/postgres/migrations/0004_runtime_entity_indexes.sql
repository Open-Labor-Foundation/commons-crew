CREATE INDEX IF NOT EXISTS runtime_state_updated_at_idx
  ON pa_runtime.runtime_state (updated_at DESC);

CREATE INDEX IF NOT EXISTS sessions_workspace_id_idx
  ON pa_runtime.sessions ((payload ->> 'workspaceId'));

CREATE INDEX IF NOT EXISTS users_email_or_login_idx
  ON pa_runtime.users ((payload ->> 'emailOrLogin'));

CREATE INDEX IF NOT EXISTS workspace_memberships_workspace_id_idx
  ON pa_runtime.workspace_memberships ((payload ->> 'workspaceId'));

CREATE INDEX IF NOT EXISTS workspace_memberships_user_id_idx
  ON pa_runtime.workspace_memberships ((payload ->> 'userId'));

CREATE INDEX IF NOT EXISTS runs_status_idx
  ON pa_runtime.runs ((payload ->> 'status'));

CREATE INDEX IF NOT EXISTS runs_session_id_idx
  ON pa_runtime.runs ((payload ->> 'sessionId'));

CREATE INDEX IF NOT EXISTS run_events_run_id_idx
  ON pa_runtime.run_events ((payload ->> 'runId'));

CREATE INDEX IF NOT EXISTS approvals_run_id_idx
  ON pa_runtime.approvals ((payload ->> 'runId'));

CREATE INDEX IF NOT EXISTS approvals_status_idx
  ON pa_runtime.approvals ((payload ->> 'status'));

CREATE INDEX IF NOT EXISTS materializations_run_id_idx
  ON pa_runtime.materializations ((payload ->> 'runId'));
