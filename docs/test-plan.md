# Test Plan for Chat/Inference Workflows

## Scope

This plan covers testing the commons-crew runtime's chat and inference
workflows, with emphasis on the VS Code extension surface and the embedded
runtime's tool loop.

## Unit Tests

Unit tests live in `packages/core/src/index.test.ts` and run via `vitest`:

```bash
npm test              # all tests
npm run test:unit     # unit only
npm run test:integration  # integration only
```

### Core Runtime

| Test | What it verifies |
|------|-----------------|
| Session lifecycle | create → post message → get session view → archive |
| Run lifecycle | queued → running → blocked (approval) → running → completed |
| Task execution | Tool loop runs, events are emitted, task completes with summary |
| Approval gate | Side-effecting tools are blocked until approved; denied approvals fail the task |
| Evidence gate | Tasks cleared for side effects must show ≥1 mutating tool call before accepting completion |
| Budget enforcement | Retry ceiling, materialization ceiling, wall-clock budget |
| Provider fallback | Transient errors trigger same-model retry, then fallback model chain |
| Auto-model selection | `model=auto` fetches catalog, ranks by tool-calling capability, builds chain |

### Config

| Test | What it verifies |
|------|-----------------|
| Profile resolution | `PA_CONFIG_PROFILE` → local/test/trusted-host; invalid value → derived fallback |
| Env override validation | Unknown `PA_*`/`OLF_*` vars are flagged, not silently applied |
| maxToolSteps | `PA_MAX_TOOL_STEPS` env var maps to `config.runtime.maxToolSteps` |
| maxConcurrentRuns | `PA_MAX_CONCURRENT_RUNS` env var maps to `config.runtime.maxConcurrentRuns` |

## Integration Tests

### VS Code Extension (headless)

The extension's `driver.ts` module is surface-agnostic (no `vscode` imports),
so it can be tested headlessly against the real runtime:

```typescript
import { createEmbeddedRuntime } from "./runtime";
import { driveRequest } from "./driver";

const { services } = await createEmbeddedRuntime({ ... });
const outcome = await driveRequest(services, "Add a /health endpoint", {
  onEvent: (e) => console.log(e.eventType),
  onApproval: () => Promise.resolve("approved"),
  timeoutMs: 60_000
});
assert(outcome.kind === "run");
assert(outcome.status === "completed");
```

### Test Scenarios

1. **Simple chat**: Send a question → PA responds with chat (no run created).
2. **Execution with approval**: Send a task → run created → approval requested →
   approved → task executes → run completes.
3. **Execution with denial**: Send a task → approval requested → denied → run
   fails with `approval_denied`.
4. **Multi-turn chat**: Continue an existing session → context preserved.
5. **Catalog sync**: First boot clones labor-commons; second boot fetches +
   resets.
6. **maxIterations enforcement**: Set `maxIterations=2` → task with >2 tool
   calls stops after 2 iterations and reports incomplete.
7. **Auto-model**: Set `model=auto` → provider catalog fetched → best
   tool-calling model selected.
8. **Fallback chain**: Primary model returns 429 → fallback model tried →
   task completes.

## Manual Test (VS Code)

1. Build and install the VSIX.
2. Set `commonsCrew.apiKey` in Settings.
3. Open a project folder.
4. Send "Add a /health endpoint with a test."
5. Verify: specialist materialized, tool calls shown in chat, approval card
   appears, file written after approval, run completes.
6. Verify: session appears in history rail, can be reopened.
7. Set `commonsCrew.maxIterations = 2`, send a complex task → verify it stops
   after 2 iterations.