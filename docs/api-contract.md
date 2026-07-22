# API Contract for VSCode Extension and Backend Services

## Overview

The commons-crew runtime exposes its services through `createAppServices()`
from `packages/core/src/index.ts`. This is the single entry point used by all
three surfaces (crew-api, crew-runner, crew-vscode). The VS Code extension
embeds it in-process; the API server wraps it in HTTP routes.

## Service Interface

`createAppServices(config, options)` returns a `CrewServices` object with
these namespaces:

### `pa` — Platform Assistant (session/chat layer)

| Method | Signature | Description |
|--------|-----------|-------------|
| `createSession` | `(surface: Surface, title: string) → Promise<{ session: SessionRecord }>` | Create a new chat session |
| `postMessage` | `(sessionId: string, content: string) → Promise<SessionView \| null>` | Post a user message; triggers intake → run creation |
| `getSession` | `(sessionId: string) → Promise<SessionView \| null>` | Get session with messages, latest run, pending clarifications |
| `listSessions` | `(surface: Surface) → Promise<SessionRecord[]>` | List sessions for a surface |
| `archiveSession` | `(sessionId: string) → Promise<void>` | Archive (soft-delete) a session |

### `runs` — Run management

| Method | Signature | Description |
|--------|-----------|-------------|
| `get` | `(runId: string) → Promise<RunView \| null>` | Get run with tasks, approvals, status |
| `events` | `(runId: string) → Promise<RunEventRecord[]>` | Get all events for a run (ordered) |
| `control` | `(runId: string, action: "cancel" \| "pause" \| "resume", reason: string) → Promise<void>` | Control a running run |

### `approvals` — Governance gate

| Method | Signature | Description |
|--------|-----------|-------------|
| `decide` | `(approvalId: string, decision: "approved" \| "denied", note: string \| undefined, actorUserId: string) → Promise<void>` | Approve or deny a pending side-effecting action |

### `runner` — Job queue

| Method | Signature | Description |
|--------|-----------|-------------|
| `claimNext` | `(runnerId: string) → Promise<RunnerJobRecord \| null>` | Claim the next queued job |
| `start` | `(jobId: string, runnerId: string) → Promise<void>` | Execute a claimed job (runs the task graph) |

### `catalog` — Specialist catalog

| Method | Signature | Description |
|--------|-----------|-------------|
| `sync` | `() → Promise<CatalogSyncRecord>` | Sync labor-commons catalog from git |
| `list` | `() → Promise<CatalogEntry[]>` | List all catalog entries |
| `get` | `(entryId: string) → Promise<CatalogEntry \| null>` | Get a specific catalog entry |

### `provider` — Inference provider

| Method | Signature | Description |
|--------|-----------|-------------|
| `proposeToolCalls` | `(input: { systemPrompt, messages, tools }) → Promise<{ content, toolCalls, usage }>` | Call the model for a tool-loop step |
| `listModels` | `() → Promise<ModelCatalogEntry[]>` | List available models (for auto-selection) |

## Authentication

### VS Code Extension

No authentication — the runtime runs in-process with the user's BYO API key.
The key is stored in VS Code settings and passed directly to the provider.

### crew-api (HTTP server)

Token-based auth via `PA_API_TOKEN` environment variable. The token is sent
in the `Authorization: Bearer <token>` header. The `trusted-host` profile
requires this; `local` and `test` profiles do not.

## Contract Versioning

API and event contracts are versioned independently (see
`packages/contracts/src/index.ts`):

- `API_CONTRACT_VERSION = "1.0"` — sent in `x-pa-api-contract-version` header
- `EVENT_CONTRACT_VERSION = "1.0"` — sent in `x-pa-event-contract-version` header

Policy: additive within major version. Breaking changes require a major
version bump.

## Event Types

The runtime emits events during task execution. Key event types consumed by
the VS Code chat view:

| Event Type | Payload | UI Rendering |
|------------|---------|--------------|
| `task.started` | `{ name, assignedAgentName }` | `▶ Specialist — task` |
| `task.reasoning` | `{ text }` | `🤔 reasoning text` |
| `task.tool_call` | `{ tool, targetRef, outcome, ok }` | `✓/✗ tool targetRef — outcome` |
| `task.completed` | `{ executionSummary }` | `↳ summary` |
| `task.usage` | `{ model, promptTokens, completionTokens }` | Usage bar update |
| `approval.requested` | `{ approvalId, taskId }` | `⏸ awaiting approval…` |

## Run Status Flow

```
queued → running → blocked (approval) → running → completed
                 → blocked (approval) → running → failed
                 → cancelled
                 → paused
```

Terminal statuses: `completed`, `failed`, `cancelled`.