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
implementing: there is no autonomous LLM tool-call loop in this codebase.
The propose → approve → execute action system is HTTP-triggered by an
external caller (`POST /api/actions/proposals`, then
`POST /api/actions/:actionId/execute`) — a client decides to propose a
tool call, the run's own task loop doesn't do it automatically mid-task.
"Plugging into the existing governed tool-execution loop" means
`delegate_to_child` is one more entry in that HTTP-driven action-proposal
system, not a tool the model calls on its own initiative.

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

**Not done here:** nothing calls this tool automatically before reaching
for build capability yet — that's the "before build capability, search
first" sequencing `ARCHITECTURE.md` describes, and it requires a caller
(a run's own task-loop reasoning, or an external orchestrator) to actually
decide to propose it. Today it's callable, verified end to end against a
real artifact-commons checkout (`search-artifacts.test.ts`), but nothing
proposes it on its own initiative.

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

- **Routing live task execution through a chair's own run — not yet
  started.** Registration alone doesn't make delegation happen: a chair's
  `commons_crew_run_id` currently sits unused once onboarding finishes.
  Actually dispatching an org's day-to-day work through that run — so
  `delegate_to_child` chains fire for real and reach the line-level catalog
  (director → department → worker) — requires deciding how commons-board's
  task/workflow model maps onto commons-crew's session/message model. That's
  a distinct, larger integration; this document doesn't specify it yet.
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
