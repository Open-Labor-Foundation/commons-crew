# Architecture — commons-crew

## Overview

commons-crew is a crew orchestration platform that materializes governed
specialists from the labor-commons catalog and runs them autonomously against
a real workspace. It has three surfaces:

1. **crew-api** — HTTP API server (Express/Fastify), used by web dashboards
   and external integrations.
2. **crew-runner** — Background runner process that claims queued jobs and
   executes tasks via the provider tool loop.
3. **crew-vscode** — VS Code extension that embeds the full runtime in-process
   (no separate server needed for local use).

All three surfaces share the same core packages.

## Package Layout

```
packages/
  contracts/    — Type definitions, enums, contract version constants
  config/       — Environment-driven config loader (PA_* env vars)
  core/         — Runtime: sessions, runs, tasks, provider tool loop,
                  governance gates, catalog sync, state store
  provider-api/ — OpenAI-compatible provider adapter with governed prompts,
                  JSON schema enforcement, auto-model selection, fallback chain
  catalog/      — Local catalog service (reads labor-commons spec.yaml files)

apps/
  crew-api/     — HTTP API server
  crew-runner/  — Background runner
  crew-vscode/  — VS Code extension (embeds core in-process)
```

## Runtime Flow

```
User message
  → PA intake (provider-api): classifies request type (chat/planning/execution),
    selects specialist candidates from catalog
  → If execution: PA creates a run with a task graph
  → Runner claims job, executes each task:
    → Materializes specialist from catalog entry
    → Runs governed tool loop (read_file, write_file, edit_file, run_command)
    → Each side-effecting tool call passes through an approval gate
    → Task completes → next task in graph
  → Run completes → PA synthesizes final result
```

## Governance Gates

- **class_c approval**: Side-effecting actions (file writes, command execution)
  require explicit approval before execution. In the VS Code extension, this
  surfaces as an inline approval card in the chat view. `autoApprove` setting
  bypasses the gate for unattended operation.
- **Evidence gate**: Tasks cleared for side effects must show at least one
  successful mutating tool call before accepting a completion message. Prevents
  the "inspected once, declared done" failure mode.
- **Budget policy**: Runs are bounded by `AUTONOMOUS_BUDGET_POLICY` —
  concurrency ceiling, wall-clock budget, retry ceiling, materialization
  ceiling.

## State Storage

- **local profile**: JSON file store (`state.json` under storage root)
- **trusted-host profile**: PostgreSQL (via `PA_DATABASE_URL`)
- **test profile**: In-memory (`pg-mem`)

The VS Code extension always uses the `local` profile with a JSON store under
the extension's `globalStorageUri`.

## Provider Integration

The provider-api package implements an OpenAI-compatible chat completion
client with:

- **Auto-model selection**: When `model = "auto"`, fetches the provider's live
  model catalog, ranks by tool-calling capability and concurrency cost, and
  builds a primary + fallback chain.
- **Transient error handling**: 429/5xx errors trigger same-model retry, then
  failover to the next model in the fallback chain.
- **Governed prompts**: System prompts are loaded from
  `catalog/platform-assistant/spec.yaml` (bundled with the extension) and
  enforce JSON schema compliance for structured outputs (intake decisions,
  chat answers, plan drafts, task execution results).

## Catalog Sync

The labor-commons catalog is never bundled. On boot, the runtime performs a
shallow git clone of `labor-commons` at the configured ref into the storage
directory. Subsequent boots fetch and hard-reset to stay current. The catalog
provides specialist definitions (spec.yaml files) that the runtime materializes
into system prompts and tool definitions for each task.