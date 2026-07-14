# Recursive delegation architecture

commons-crew is meant to be a single primitive used at every layer of an
organization governed by commons-board — chair, director, department,
worker — each layer just another instance of commons-crew, scoped one
level down from whichever instance created it. See
[open-labor-foundation/ARCHITECTURE.md](https://github.com/Open-Labor-Foundation/open-labor-foundation/blob/main/ARCHITECTURE.md)
for how this fits the rest of the stack; this document is about how the
mechanism itself works.

**Status: implemented and merged to `main`.** Single-hop and multi-hop
delegation both work end to end, verified by real tests exercising the
public propose → approve → execute API (`tests/integration/delegate-to-child.test.ts`),
including a full chair → director → department → worker chain.
`pa.createChairRun` (see Instance identity) gives commons-crew its own
side of chair registration, now reachable externally via `POST /api/chairs`
(`apps/crew-api/src/create-app.ts`) — commons-board's onboarding flow calls
it to register every chair as a real commons-crew run.
`pa.requestDelegationApproval` (see "Requesting delegation approval again",
below) fixes the one-shot approval limitation that would otherwise have
made a chair only able to delegate once, ever. Dynamic chair assignment is
still open (see below); routing a chair's live task execution through its
own run so `delegate_to_child` chains actually fire — the commons-board
side of *using* these two primitives together, repeatedly, over a chair's
lifetime — is a distinct, larger integration also still open (see below).

One correction from the original version of this document, found while
implementing: for `class_b`/`class_c` tools — `delegate_to_child` included —
there is still no autonomous LLM tool-call loop. The propose → approve →
execute action system for those stays HTTP-triggered by an external caller
(`POST /api/actions/proposals`, then `POST /api/actions/:actionId/execute`)
— a client decides to propose that kind of tool call, and approval still
runs through `ApprovalRecord`. "Plugging into the existing governed
tool-execution loop" means `delegate_to_child` is one more entry in that
HTTP-driven action-proposal system, not a tool the model calls on its own
initiative.

That said, a real autonomous loop *does* now exist, deliberately scoped to
tools that were already approval-free by policy — see "Autonomous
invocation: the 'search first' loop" under Artifact matching, below. A
task's own execution can call `search_artifacts` mid-task with no external
caller proposing it; nothing `class_b`/`class_c` is reachable that way, and
never will be without a separate, explicit decision to widen the allowlist.

## Instance identity

Every commons-crew run (`RunRecord`) may carry a `delegation` field,
`null` for a root instance (a chair, or a standalone personal-assistant
run with no organizational context):

- **`layer`** — `"chair" | "director" | "department" | "worker"`. Not
  open-ended; see Chair assignment below for why the top of this is a
  fixed set in v1.
- **`parentRunId` / `parentTaskId`** — the run and task that delegated to
  this one.
- **`orgContext`** — which commons-board deployment this instance belongs
  to. `null` for standalone personal use.
- **`scope`** — the specific responsibility arm or delegated task this
  instance owns.

This extends the existing domain model rather than replacing it — a field
added to `RunRecord` (`packages/contracts/src/index.ts`), alongside the
existing `rerunSourceRunId`/`rerunTriggeredBy` lineage pair that was the
closest existing precedent for one run pointing back to another.

A root run can also carry a `chairRegistration` field instead —
`{ orgContext, chairRole }`, `chairRole` restricted to the fixed v1 set
(see Chair assignment below). This is the counterpart to `delegation` for
the *top* of a chain: nothing delegated to a chair, an external caller
created it directly, so there's no `parentRunId`/`parentTaskId` to carry.
`pa.createChairRun(orgContext, chairRole, surface, title)` is the entry
point — it bypasses the conversational intake path (`decideIntake`,
specialist selection) entirely, since registering a chair is an
administrative act, not a request to classify. A run is never both —
`delegation` and `chairRegistration` are mutually exclusive by
construction (a delegated child always gets `chairRegistration: null`).
`layer` for a chair-registered run is implicit rather than stored
directly: `nextLayerDown` already treats any run with no `delegation` as
chair-layer (`parentRun.delegation?.layer ?? "chair"`), so a
chair-registered root run and an ordinary unregistered root run behave
identically for delegation purposes — registration's job is narrower:
attaching an explicit `orgContext` so descendants inherit one
(`createDelegatedChildRun` now checks `chairRegistration.orgContext` as a
fallback alongside `delegation.orgContext`), and pre-seeding the same
delegation-capability approval a non-worker delegated child gets (see
Delegation mechanism) so a freshly registered chair can delegate
immediately rather than waiting for one of its own tasks to happen to
trip `requiresApproval()`.

## Delegation mechanism

`delegate_to_child` is a new entry in the existing action-tool system —
same `ACTION_TOOL_POLICIES` registry, same class_c approval gate, same
proposal/execution flow as `write_file` or `deploy` today
(`packages/core/src/index.ts`). Because spawning a child run needs deep
access to run/task state that the generic filesystem-oriented
`ActionToolExecutor` (`action-executor.ts`) doesn't have, it's handled by
a dedicated `executeDelegateToChild` function inside the same closure as
the rest of run/task state, not inside `action-executor.ts` itself.

The child is created by `createDelegatedChildRun` — deliberately simpler
than the normal `createRunFromRequest` path: a delegated child doesn't
need specialist selection or materialization at spawn time, since it
assembles its own specialists from labor-commons when it actually runs,
the same way any root instance does. It reuses the parent's
session/workspace/work-item/request context rather than synthesizing new
records, since a delegation isn't a new user request, it's an internal
continuation of the same one. The child's `layer` is computed
automatically as one step below the parent's (`nextLayerDown`) — a worker
cannot delegate further.

This was a deliberate choice: the action-proposal engine already works
(propose, approve, execute, with explicit gating on real-world side
effects). Recursion is a new *tool*, not a new *engine*.

## Requesting delegation approval again: `pa.requestDelegationApproval`

The pending `ApprovalRecord` seeded at chair registration or child creation
is one-shot by construction: `createProposal` refuses to bind a second,
different action proposal to an approval that's already bound to one
(`"the existing approval does not cover this exact tool and target
surface"`, `packages/core/src/index.ts`). That's correct behavior for an
approval — it authorizes one specific act, not a standing blank check — but
it means a long-lived chair run had no way to delegate a *second* time
after its first `delegate_to_child` executed, which breaks the model for
any caller (commons-board, dispatching more than one piece of board work to
an already-registered chair over its lifetime) that expects a chair to keep
being usable.

`pa.requestDelegationApproval(runId)`, exposed as `POST
/api/runs/:runId/delegation-approvals`, is the fix: it seeds a fresh
pending approval on the same run/task, so a caller can request
authorization again rather than the chair being a use-once primitive.
Idempotent if a pending approval already exists (returns it instead of
seeding a duplicate). Rejects runs that aren't part of a delegation chain
(no `chairRegistration` and no `delegation`) and worker-layer runs (nothing
below worker to delegate to). Still requires an explicit approval decision
each time — this does not bypass human oversight, it just makes *asking*
for delegation capability repeatable instead of one-shot. Verified end to
end, including the negative case (reusing the old, now-bound approval for a
second proposal genuinely fails first) in
`tests/integration/redelegatable-approvals.test.ts`.

## Chair assignment (v1: fixed, not dynamic)

Chairs are hard-assigned to a fixed set of functional roles — finance,
legal, HR, marketing, operations, product — matching what commons-board's
own README already documents. This is a deliberate, non-obvious choice:
mother-board (the system this stack evolved from) tried dynamic chair
assignment, and it underperformed hard-assigned functional chairs in
practice. Dynamic assignment may still be the better long-term model, but
it hasn't been proven, and v1 of recursive delegation shouldn't be gated
on solving that unproven problem. Dynamic chair creation is deferred —
tracked as an open question below, not a v1 requirement.

## Completion reporting: asynchronous

A parent instance does not block on a delegated task — the same way a
project manager doesn't sit idle waiting on a junior dev before picking up
other work. Concretely, `delegate_to_child`'s own action completes as soon
as the child run is spawned (like any other class_c action) — it does not
leave the parent run or task blocked.

**Correction from the original version of this document:** the reasoning
loop in this codebase does not poll or react to `state.runEvents` as a
queue — task progression is driven by direct recursive calls
(`executeRun` calling itself after each task), and a blocked run only
resumes when something explicitly requeues its `RunnerJobRecord` (the
mechanism the existing approval-decision handler uses). Appending an event
alone does not wake anything.

That turns out to be the right mechanism for this design, not a gap to
patch: since the parent was never blocked in the first place, it doesn't
need waking. When a child run reaches a terminal status, `setRunStatus`
appends a `delegation.completed` event to the *parent's* stream, tagged
with the originating task (`parentTaskId`), carrying the child's outcome.
That event sits on the parent's run as a durable record the parent (or
whoever's operating it) sees whenever it's next active or queried — the
same as how a project manager finds out a task finished by checking in,
not by being interrupted the instant it happens. A parent can have
multiple delegated tasks in flight at once; each completes independently
and reports back the same way.

A future need for a parent to *actively wait* on a specific delegation
(rather than just eventually noticing it) would need the blocking +
runner-job-requeue mechanism the approval flow already uses — that's a
distinct, not-yet-built extension, not something this implementation
does today.

## Approval propagation

A request needing human or higher-authority approval bubbles up its own
delegation lane only — chair to director to department to worker, and
back — stopping wherever it's actually resolved. It does not necessarily
reach a human every time; an intermediate layer may have standing
authority (per its autonomy tier) to answer without escalating further.

## Audit trail structure: per-lane, not flat

Each instance's log stays scoped to itself and its own descendants rather
than merging into one flat table — a chair reviewing its own trail
shouldn't have to wade through the routine work of every other chair's
entire delegation tree. This is not the same as isolated: a chair's log
must still be traversable down into its children's logs on demand, so the
whole tree is auditable end to end. commons-board's immutable audit trail
depends on this remaining a tree, not a set of disconnected islands.

## Artifact matching: `search_artifacts`

`open-labor-foundation/ARCHITECTURE.md` resolves artifact-commons matching
as "a commons-crew tool, not a separate service... the same governed loop
that already exists, just with one more tool type added to it." This is
that tool.

`search_artifacts` is `class_a` — read-only, no approval required, no dry
run or preflight (there's nothing to preview; a search either finds
matches or it doesn't) — registered in `ACTION_TOOL_POLICIES` exactly like
`read_file`/`inspect_workspace`, and implemented the same way those are:
inline in `action-executor.ts`, no separate catalog-client class. That's a
real difference from labor-commons' `LocalCatalogService`, not an
oversight — artifact-commons' `catalog.json` is a flat index (one JSON
file with a `packs` array), not a tree of per-artifact spec files to walk
and validate, so there's no scan/sync step to abstract.

Given a query string (the proposal's `targetRef`), it reads
`{ARTIFACT_COMMONS_ROOT}/catalog.json`, scores each pack by how many
query terms appear across its id/name/description/artifact_types/tags,
and returns the top 5 non-zero matches. `ARTIFACT_COMMONS_ROOT` defaults
to `<repo-root>/../artifact-commons`, matching `OLF_AGENTS_ROOT`'s
sibling-checkout convention for labor-commons.

Like `delegate_to_child`'s payload living on the run's event log rather
than the direct `execute()` response, `search_artifacts`' actual match
list isn't in the `ActionExecutionRecord` either — that only carries a
flattened `outcome` string. The structured payload is written to the
action's execution-evidence artifact (`{artifactsRoot}/action-evidence/
{actionId}/execution-evidence.json`), the same durable-evidence mechanism
every action tool uses.

If `ARTIFACT_COMMONS_ROOT` isn't checked out (artifact-commons is an
optional dependency, same reasoning as commons-board's `CB_COMMONS_CREW_URL`
being optional), the tool doesn't throw — it reports
`artifact_catalog_unavailable` as a normal, non-error outcome.

### Autonomous invocation: the "search first" loop

A task's own execution now calls `search_artifacts` on its own initiative,
mid-execution, before giving a final answer — no external caller has to
propose it. This is the "before build capability, search first" sequencing
`ARCHITECTURE.md` describes, and it required building a real capability that
didn't exist anywhere in this codebase before: a task-level tool-call loop.
Every other action proposal, including `delegate_to_child`, is still
HTTP-triggered by an external caller deciding to propose it — this is the
first and only path where the run's own task execution decides *which* tool
to call based on the task's own content, with no caller in the loop.

**Scope: now reached via `shared_runner` and `isolated_subprocess` — the
production default. `worker_container` still isn't.**
`resolveSpecialistExecutionMode` (`packages/core/src/specialist-worker-runtime.ts`)
picks between three modes per task: `shared_runner`, `isolated_subprocess`,
and `worker_container`. `isolated_subprocess` is the default for any task
with an assigned specialist under the production (`trusted-host`) profile —
i.e. most chair/director/department/worker execution tasks, the common
case this loop previously never reached at all.

**What changed and why it was safe to extend.** `executeTaskWithAutonomousTools`
now takes a `callModel` function instead of hardcoding `provider.executeTask`
— defaulting to the in-process provider call (`shared_runner`), or
`executeTaskInSubprocess` when the mode is `isolated_subprocess`. The loop,
the turn cap, the double-gate below, and the audit events are unchanged and
still run entirely in *this* process; only how the model itself gets called
differs (an in-process call vs. a real `tsx` child process round trip per
turn, via the same `executeTaskInSubprocess`/`apps/crew-runner/src/specialist-worker.ts`
mechanism a single-shot task already used). `specialist-worker.ts` itself
needed zero changes — it already round-trips whatever `TaskExecutionInput`
it's given (including `availableTools`/`toolResults`) through
`provider.executeTask` and writes back the full `TaskExecutionResult`
(including `toolCalls`), so it was already a correct single-turn primitive;
the fix was making the governed loop call that primitive repeatedly instead
of once, with tool execution and approval logic staying where the
governance state already lives (the parent process), never crossing into
the child. This means each turn under `isolated_subprocess` re-spawns a
process — more overhead than the in-process loop, but correct, and no
worse than the isolation model this mode already committed to per task.

`worker_container` still doesn't reach the loop: unlike a subprocess, it's
a genuine container boundary (`docker run`) with no established callback
path back into this process's `actions`/`store`, and it's never a profile
default (only reachable via an explicit `PA_SPECIALIST_EXECUTION_MODE`
override) — porting the loop there is real, separate, unstarted work.
`availableTools` is still stripped to `[]` before that path for the same
reason as before: never invite a tool call nothing can act on. (Incidental
fix while touching this file: `worker_container`'s in-container script path
was stale — `/app/apps/pa-runner/src/specialist-worker.ts`, a directory
that doesn't exist in this repo — corrected to `/app/apps/crew-runner/...`;
found while reading the code for this change, unrelated to the loop itself,
and still untested since this mode has no test coverage and is never a
default.)

Verified with a real child process, not an in-process stand-in:
`tests/integration/autonomous-tool-selection-isolated-subprocess.test.ts`
forces a real catalog fixture (so the task gets an actual assigned
specialist, not the null-specialist case that always stays on
`shared_runner`) and `PA_SPECIALIST_EXECUTION_MODE=isolated_subprocess`,
then points `PA_PROVIDER_BASE_URL` at a local fake HTTP server — the real,
unmodified `apps/crew-runner/src/specialist-worker.ts` is what calls it,
via the real `createApiProvider`, in a real spawned `tsx` process. The
in-process test provider is wired to throw if it's ever called for the
task under test, so the test fails loudly rather than silently passing on
the wrong code path. Confirms `task.autonomous_tool_call_executed` fires
and the task's final result incorporates the real search result, exactly
like the existing `shared_runner` test
(`tests/integration/autonomous-tool-selection.test.ts`).

**How it's structurally kept safe.** A task deciding for itself to call a
tool must never be able to bypass the human-approval gate a `class_b`/`class_c`
tool would otherwise require through the normal external action-proposal
flow. Autonomous calls are gated twice, not once:

- `AUTONOMOUS_TOOL_DESCRIPTORS` (`packages/core/src/index.ts`) is the
  allowlist offered to the provider on every task — currently just
  `search_artifacts`, deliberately not every `class_a` tool (`read_file`/
  `inspect_workspace` are workspace introspection, not part of this
  sequencing, so they stay caller-only).
- `executeTaskWithAutonomousTools` re-checks every requested `toolId`
  against the live `ACTION_TOOL_POLICIES` registry before executing
  anything — `class_a` and `requiresApproval: false` or it's rejected. This
  is deliberate redundancy: if `AUTONOMOUS_TOOL_DESCRIPTORS` ever drifted
  from `ACTION_TOOL_POLICIES` (someone adds a tool to the allowlist without
  checking its policy class), the second gate still holds, not just the
  first. A rejected call executes nothing, proposes nothing, and is never
  silently dropped — it appends `task.autonomous_tool_call_rejected` to the
  run's event log with the toolId, same audit trail as everything else.

**The loop itself.** `buildTaskExecutionInput` hands every task
`availableTools: AUTONOMOUS_TOOL_DESCRIPTORS` and `toolResults: []`. If the
provider's `executeTask` response includes non-empty `toolCalls`, the task
isn't finished: `executeTaskWithAutonomousTools` runs the same
`createProposal` → `execute` path an external caller would, records
`task.autonomous_tool_call_executed` (toolId, targetRef, actionId, outcome),
and calls `executeTask` again with `toolResults` populated from the real
execution evidence — same evidence-file mechanism described above, not a
synthesized shortcut. This can repeat up to `MAX_AUTONOMOUS_TOOL_TURNS` (5)
times; if a task is still requesting tools at the cap, the final call is
made with `availableTools: []` to force a real answer instead of looping
forever.

Verified twice, at increasing levels of realism, after finding the first
pass wasn't actually sufficient evidence:

1. Against a real, separately-running `crew-api` process using its
   built-in deterministic HTTP test provider: `POST /api/sessions/:id/messages`
   → runner claim/start → the task requested `search_artifacts` with no
   external caller involved, the real action executed and wrote a real
   evidence file under `action-evidence/{actionId}/`. This proved the
   *loop and gating* work, but not that a real model could ever reach
   them — an independent audit found `packages/provider-api/src/index.ts`'s
   `TASK_EXECUTION_SCHEMA` had no `toolCalls` property at all (`additionalProperties: false`
   made it impossible for a real model to emit one), and separately that
   the same file's `getStatus()` self-reported `supportsStreaming`/
   `supportsToolCalls`/`supportsFileIo`/`supportsCancellation` as `false` —
   which, combined with `requiredProviderCapabilities` in `packages/core`
   requiring all four `true`, meant **no run had ever been able to execute
   through the real API-backed provider at all**, a pre-existing defect
   unrelated to this feature, surfaced while trying to verify it honestly.
   Both are now fixed: the schema has a real, nullable `toolCalls` array
   property, the system prompt (`catalog/platform-assistant/spec.yaml`'s
   `toolUse` section) explains `availableTools`/`toolCalls`/`toolResults`
   to the model, and `getStatus()`'s capabilities match every other
   provider in this codebase.
2. Against that same real, separately-running process, with a real
   `PA_PROVIDER_API_KEY` and Featherless's `Qwen/Qwen3-32B`, no test double
   anywhere in the path: the "Analyze request" task's own model call
   decided, unprompted, to request `search_artifacts` for "gig worker
   delivery cooperative service catalog," with reasoning text it generated
   itself ("Need to check artifact-commons for existing reusable solutions
   before creating new content as requested...") captured in the real
   evidence file, found the real `gig-cooperative` artifact, and the run's
   own final task summary explicitly used the result ("Existing 'Gig
   Worker Cooperative' artifact found in artifact-commons. Applied service
   catalog configuration pack to workspace."). This is the actual
   claim this document makes now — not the test-provider pass alone.

`search-artifacts.test.ts` and `autonomous-tool-selection.test.ts` cover
the loop and gating in-process, including the rejection path for a tool
that isn't on the safe list — but per the above, an in-process or
test-provider pass alone is not sufficient evidence that a real model can
reach the feature; both need checking.

**Still true, and still a caller-side decision, not something removed:**
this loop only ever offers tools that are safe to run with zero human
involvement. Any `class_b`/`class_c` tool — `write_file`, `delegate_to_child`
— stays exactly as gated as it already was: an external caller (a human, or
commons-board's dispatch mechanism) still has to decide to propose those,
and approval still runs through the same `ApprovalRecord` flow. Nothing
about this loop weakens that; it only adds a second, narrower path for the
specific tools that were already approval-free by policy.

## Open questions (deferred, not v1)

- **Dynamic chair assignment.** Revisit only after the recursive mechanism
  is proven with the fixed chair set above.
- ~~Chair registration with commons-board — half built.~~ **Resolved.**
  `pa.createChairRun` is reachable externally via `POST /api/chairs`
  (`apps/crew-api/src/create-app.ts`), and commons-board's onboarding flow
  (`generate-artifacts.ts`'s `buildBlueprintChairs`) calls it once per chair
  at the point the chair is created, storing the returned run/session id on
  the chair record. `CHAIR_ROLES` grew from six to eight (`it`, `security`
  added) to cover commons-board's actual guaranteed onboarding domain set —
  without that, two of every org's six chairs would have failed
  registration outright.

  This is deliberately scoped: commons-board keeps its own axis-aware
  labor-commons search as the mechanism that picks which specialist to
  preview/pin for a chair at onboarding (a legitimate, human-reviewable
  product behavior, not what this gap was about). What changed is that
  every chair is now also a real, governed commons-crew run — audit trail,
  autonomy tiers, and `delegate_to_child` capability all now exist for every
  chair from the moment it's created.

- ~~Routing live task execution through a chair's own run — not yet
  started.~~ **Split into two questions that turned out to have different
  answers.** *Whether a chair's run gets dispatched real work at all* is
  commons-board's question, answered separately (see
  `open-labor-foundation/ARCHITECTURE.md`'s commons-board section: a real
  UI proposes/approves/denies dispatch per board request, opt-in per
  request via a checkbox). *Whether reaching the line-level catalog
  (director → department → worker) requires a human to explicitly approve
  every single hop once dispatch starts* was the part still genuinely
  unaddressed here, and is now fixed: `delegate_to_child`'s approval
  requirement is no longer a fixed `true` regardless of context.
  `computeDelegationRequiresApproval` (`packages/core/src/index.ts`)
  overrides it per-proposal based on the org's autonomy tier, synced in
  from commons-board (never decided by commons-crew itself) via
  `pa.setOrgAutonomyTier` / `PUT /api/orgs/:orgContext/autonomy-tier`,
  defaulting an org with no synced tier to `advisor` — fail closed, not
  fail open. `advisor` is unchanged (every hop still gated). `orchestrator`
  auto-approves every hop except the final one into `worker`, where a task
  gets real tool access — matching GOVERNANCE.md's "routine actions
  execute automatically... anything above a defined risk threshold still
  escalates." `autopilot` auto-approves every hop including into worker,
  capped by `AUTOPILOT_MAX_AUTO_APPROVED_DELEGATIONS_PER_ORG` (20) existing
  delegated runs for the org — a hard backstop against runaway recursive
  spawning independent of tier. Verified end to end, no test double:
  a real chair → director → department → worker chain executing under
  `autopilot` with zero approval decisions anywhere in the test
  (`tests/integration/org-autonomy-tier-delegation.test.ts`), contrasted
  against the same chain under `advisor`/no-synced-tier still blocking on
  `approval_required` exactly as before. Caught and fixed a real gap while
  verifying this against the actual `execute()` path, not just
  `createProposal`: `execute()`'s class_c gate checked
  `proposal.actionClass === "class_c"` directly, ignoring whether that
  *specific* proposal's `approval.required` was actually `true` — an
  auto-approved proposal would have been correctly created and then
  immediately rejected by `execute()` regardless. Fixed to check
  `proposal.approval.required`, which `createProposal` already sets
  correctly per-proposal.

  **Fixed:** commons-board now calls the sync route. `syncOrgAutonomyTier`
  (`services/api/src/lib/commons-crew-client.ts`) PUTs the org's
  `autonomy_policy.autonomy_mode` (from the interview onboarding flow's own
  `S5` answers, same `advisor`/`orchestrator`/`autopilot` vocabulary, fail-
  closed to `advisor` if unanswered) to this endpoint, called once per org
  in `buildAgentBlueprint` before any of that org's chairs are registered —
  so a chair's first `delegate_to_child` proposal already reflects the
  org's real choice rather than commons-crew's default. Non-fatal on any
  failure, same reasoning as `registerChair`: commons-crew isn't guaranteed
  deployed alongside every commons-board instance. Verified live against a
  real running instance of this service (not a test double): registered a
  chair for an org synced to `orchestrator`, proposed `delegate_to_child`
  on that chair's run, confirmed `approval.required: false`, executed it,
  confirmed a real `child_run_delegated` outcome with zero approval
  decisions — the same behavior the automated integration test asserts,
  reproduced end to end through commons-board's actual client code.

  **What's still open:** commons-board's separate *launch* onboarding flow
  (`agent-runtime/launch/generate-artifacts.ts`, distinct from the
  *interview* flow wired above) sets its own `autonomy_policy` but never
  calls `registerChair` at all, so it has no commons-crew runs to sync a
  tier onto — not a gap in this feature, since there's nothing there yet to
  gate, but worth naming so it isn't mistaken for "also covered."
- ~~Multi-hop chains beyond one level~~ **Fixed.** `createDelegatedChildRun`
  now seeds a *pending* `ApprovalRecord` on the child's own run/task at
  spawn time for any layer except `worker` — pre-provisioning the
  capability to delegate further without forcing a human sign-off before
  the child can even start (the seeded approval only matters if and when
  the child itself proposes `delegate_to_child`; it doesn't block the
  child's own task, which stays `approvalRequired: false`). Verified end to
  end for the full chain — chair → director → department → worker — in
  `tests/integration/delegate-to-child.test.ts`, including confirming
  worker gets no seeded approval and any delegation attempt from worker
  fails closed the same way an unapproved attempt does anywhere else in
  the chain.
