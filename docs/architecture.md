# Recursive delegation architecture

commons-crew is meant to be a single primitive used at every layer of an
organization governed by commons-board — chair, director, department,
worker — each layer just another instance of commons-crew, scoped one
level down from whichever instance created it. See
[open-labor-foundation/ARCHITECTURE.md](https://github.com/Open-Labor-Foundation/open-labor-foundation/blob/main/ARCHITECTURE.md)
for how this fits the rest of the stack; this document is about how the
mechanism itself works.

**Status: the core mechanism below is implemented** on
`feature/recursive-delegation`, not yet merged to `main`. Chair
registration with commons-board and dynamic chair assignment are still
open (see below).

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

## Open questions (deferred, not v1)

- **Dynamic chair assignment.** Revisit only after the recursive mechanism
  is proven with the fixed chair set above.
- **Chair registration with commons-board.** How a root commons-crew
  instance actually becomes "the IT chair" for a specific commons-board
  deployment — direct spawn by commons-board, or self-registration against
  it — isn't decided. Nothing in this implementation creates a root/chair
  instance yet; `createDelegatedChildRun` only handles the child side of
  one delegation hop.
- **Multi-hop chains beyond one level.** Verified end to end for a single
  parent → child hop. A child delegating to its own child (director →
  department) should work by the same mechanism, but hasn't been
  exercised by a test yet.
