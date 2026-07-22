# commons-crew

A personal-assistant front end for an individual, backed by the same
governed specialists as [commons-board](https://github.com/Open-Labor-Foundation/commons-board):
describe what you need, and commons-crew assembles the right specialists
from [labor-commons](https://github.com/Open-Labor-Foundation/labor-commons)
for the task rather than running an open-ended agent.

## What it does

- Accepts open-ended requests in plain language — no fixed task menu
- Assembles specialists from labor-commons on demand for the task at hand
- Runs the specialist conversation visibly — watch it, redirect it, stay in control
- Asks clarifying questions before starting when it matters
- Requires your approval before anything with real-world impact
- Returns a clear result when the work is done

## Quickstart

```bash
PA_PROVIDER_API_KEY=<your-key> PA_API_TOKEN=<generate-with-openssl-rand-hex-32> npm run docker:up
```

- API: http://127.0.0.1:4000 (health check at `/health`)
- Runner: http://127.0.0.1:4001

`PA_PROVIDER_MODEL` defaults to `Qwen/Qwen3-32B`; set it to whatever model
your provider serves. Conversations, approvals, and results are stored
locally in Postgres — auditable and resumable.

`PA_API_TOKEN` is required — the API port is published on the host network,
so every request except `/health` must include it as
`Authorization: Bearer <token>`.

## Roadmap: who this is for today

Docker + terminal is the deployment path right now — a real barrier for the
individual workers this is ultimately built for, most of whom won't set an
environment variable and run a compose file by hand. A no-terminal
deployment (desktop and mobile apps) is a near-term commitment, not built
yet.

## Deploy on Featherless

commons-crew can run as a user-deployed agent on
[Featherless.ai](https://featherless.ai)'s agent platform. The root
[`Dockerfile`](Dockerfile) is self-contained — no Postgres, no external
database, catalog auto-synced from labor-commons at boot.

**How it works:**

1. Featherless mirrors this repo from GitHub to its internal GitLab
2. Featherless builds the Docker image from the root `Dockerfile` and pushes
   to `docker.io/featherlessai/commons-crew:<tag>`
3. Featherless pulls the image, injects the user's API key as
   `FEATHERLESS_API_KEY`, and the container maps that to
   `PA_PROVIDER_API_KEY` at startup
4. Featherless proxies requests to port 8080 and health-checks `/health`

**What the user needs to do:**

- Push this repo (with the root `Dockerfile`) to the `main` branch on
  [GitHub](https://github.com/Open-Labor-Foundation/commons-crew)
- Trigger a re-sync on the Featherless agent platform at
  `featherless.ai/account/agents/apps/commons-crew`
- Featherless mirrors, builds, and deploys automatically

**Configuration:**

The default model is `Qwen/Qwen3-32B` on Featherless's API. To override,
set `PA_PROVIDER_MODEL` in the Featherless build environment.

**Known limitation — ephemeral state:**

Featherless containers are ephemeral. Conversation history is lost on
container restart. The agent itself works fine — the specialist catalog
re-syncs from labor-commons git at boot. If Featherless adds persistent
volumes in the future, mount at `/app/.data` to preserve state.

## Part of the Open Labor Foundation

[labor-commons](https://github.com/Open-Labor-Foundation/labor-commons) —
the specialist catalog this draws from · [commons-keeper](https://github.com/Open-Labor-Foundation/commons-keeper)
— keeps it current · commons-crew — you are here · [commons-board](https://github.com/Open-Labor-Foundation/commons-board)
— run an organization with the same catalog · [commons-idea](https://github.com/Open-Labor-Foundation/commons-idea)
— turn an idea into running software, then bring it here to operate

## License

AGPL-3.0.
