# Recursive delegation architecture

commons-crew is meant to be a single primitive used at every layer of an
organization governed by commons-board — chair, director, department,
worker — each layer just another instance of commons-crew, scoped one
level down from whichever instance created it. See
[open-labor-foundation/ARCHITECTURE.md](https://github.com/Open-Labor-Foundation/open-labor-foundation/blob/main/ARCHITECTURE.md)
for how this fits the rest of the stack; this document is about how the
mechanism itself works.

None of this is implemented yet. The current codebase is a single flat
instance per individual user, with the governed tool-execution loop
(propose → approve → execute) as its core engine but no way for one
instance to address or delegate to another.

## Instance identity

Every commons-crew instance carries:

- **`layer`** — chair / director / department / worker. Not open-ended;
  see Chair assignment below for why the top of this is a fixed set in v1.
- **`parent_instance_id`** — the instance that delegated to this one.
  `null` for a root instance (a chair, or a standalone personal-assistant
  instance with no organizational context at all).
- **`org_context`** — which commons-board deployment this instance
  belongs to. Empty for standalone personal use.
- **`scope`** — the specific responsibility arm or delegated task this
  instance owns (e.g. "IT chair," or the specific task a worker instance
  was handed).

This extends the existing domain model rather than replacing it — a field
set added to the run/workspace records commons-crew already has, not a
new concept bolted on beside them.

## Delegation mechanism

Delegation is a new tool in the existing governed tool-execution loop, not
a separate system. A `delegate_to_child` tool call goes through the same
propose → approve → execute path as `write_file` or `run_command` today,
gated the same way. Whatever instance receives it is spawned or addressed
with a `parent_instance_id` pointing back to the delegating instance and a
`scope` narrowed to the delegated task.

This was a deliberate choice: the engine already works (propose, approve,
execute, with explicit gating on real-world side effects). Recursion is a
new *tool*, not a new *engine*.

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
other work. A child instance's completion appends an event to the parent's
own event stream (the existing `RunEventRecord` / `appendEvent`
machinery), which the parent's normal reasoning loop picks up on its next
pass, exactly like any other inbound signal. A parent can have multiple
delegated tasks in flight at once.

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
- **Cross-instance event schema.** The exact shape of a completion event
  a child appends to its parent's stream isn't specified yet.
- **Chair registration with commons-board.** How a root commons-crew
  instance actually becomes "the IT chair" for a specific commons-board
  deployment — direct spawn by commons-board, or self-registration against
  it — isn't decided.
