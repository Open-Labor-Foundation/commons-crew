# commons-crew

A personal-assistant front end for an individual, backed by the same
governed specialists as [commons-board](https://github.com/Open-Labor-Foundation/commons-board):
describe what you need, and commons-crew assembles the right specialists
from [labor-commons](https://github.com/Open-Labor-Foundation/labor-commons)
for the task rather than running an open-ended agent.

> **Known shortcomings:** see [open-labor-foundation/ARCHITECTURE.md](https://github.com/Open-Labor-Foundation/open-labor-foundation/blob/main/ARCHITECTURE.md)
> for the full ecosystem picture. Not implemented as envisioned: commons-crew
> is meant to be a recursively-instantiable delegation primitive, used
> uniformly at every layer of an organization — including as commons-board's
> chairs themselves — where one instance delegates to a child instance scoped
> one level down and reports back up. The current implementation is a single
> flat personal assistant for one individual, with no delegation between
> instances, no notion of organizational layer or scope, and no connection
> back to commons-board. This is the highest-priority piece of unbuilt
> architecture in the stack; most of what's missing elsewhere depends on it.

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

## Part of the Open Labor Foundation

[labor-commons](https://github.com/Open-Labor-Foundation/labor-commons) —
the specialist catalog this draws from · [commons-keeper](https://github.com/Open-Labor-Foundation/commons-keeper)
— keeps it current · commons-crew — you are here · [commons-board](https://github.com/Open-Labor-Foundation/commons-board)
— run an organization with the same catalog · [commons-idea](https://github.com/Open-Labor-Foundation/commons-idea)
— turn an idea into running software, then bring it here to operate

## License

AGPL-3.0.
