# commons-crew for VS Code

Autonomous coding with **governed specialists materialized from the labor-commons catalog**.

Open the Chat view and talk to `@commons-crew`. It materializes the right
software-engineering specialist from labor-commons (live, over the network — the
catalog is never bundled), then works your task autonomously in the open
workspace: reading code, editing files, and running commands, iterating until
the task is done.

## Setup

1. Set **`commonsCrew.apiKey`** in Settings — your own inference key (BYO). The
   runtime runs locally in the extension and calls your endpoint directly; the
   key never leaves your machine except to the provider you chose.
2. (Optional) Set `commonsCrew.baseUrl` / `commonsCrew.model` — defaults to a
   tool-calling-capable model on an OpenAI-compatible endpoint.

## Governance

File writes and command execution pass through an approval gate — you're asked
to confirm each side-effecting action. Set `commonsCrew.autoApprove` to `true`
to let it run unattended.
