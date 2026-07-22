# commons-crew — Featherless Agent Platform Dockerfile
#
# This is the root Dockerfile that Featherless builds. It is adapted from
# infra/docker/Dockerfile.runtime — the self-contained, droppable runtime
# that was designed for "a Featherless-style runtime slot."
#
# Featherless injects the user's API key as FEATHERLESS_API_KEY. We map it
# to PA_PROVIDER_API_KEY (what CC's config layer expects). Everything else
# has a sane default: local profile (file-backed state, no Postgres), port
# 8080, catalog auto-synced from labor-commons main, inference via
# Featherless's own API.
#
# No CC source code changes are needed — this is purely a deployment artifact.

FROM node:20-alpine

# git: used at boot to mirror the catalog from labor-commons main.
RUN apk add --no-cache git

WORKDIR /app

# App code + commons-crew's OWN bundled agent/governance. The labor-commons
# specialist catalog is deliberately NOT copied here — it is a live link
# fetched at boot (see CATALOG_* below). Copy the whole workspace before
# install so npm can resolve the monorepo workspaces.
COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY governance ./governance
COPY catalog ./catalog

# Install deps (tsx is a dev dependency and the runtime is tsx-executed, so we
# keep dev deps — do not set NODE_ENV=production before this).
RUN npm ci

# Self-contained profile: file-backed state store, no external database.
ENV PA_CONFIG_PROFILE=local
ENV PA_API_PORT=8080

# Persistent runtime state. On Featherless, containers are ephemeral — state
# is lost on restart. The agent still works (catalog re-syncs from git at
# boot); only conversation history is lost.
ENV PA_STATE_FILE=/app/.data/state.json
ENV PA_ARTIFACTS_ROOT=/app/.data/artifacts
ENV PA_BACKUPS_ROOT=/app/.data/backups

# Catalog = live link to labor-commons main, mirrored at boot into OLF_AGENTS_ROOT.
ENV CATALOG_AUTO_SYNC=1
ENV OLF_AGENTS_ROOT=/app/.data/catalog
ENV CATALOG_REPO_URL=https://github.com/Open-Labor-Foundation/labor-commons.git
ENV CATALOG_REF=main

# Inference via Featherless. Featherless injects FEATHERLESS_API_KEY at
# run time; we map it to PA_PROVIDER_API_KEY (what CC's config layer reads)
# in the shell-form CMD below. ENV would resolve at build time when
# FEATHERLESS_API_KEY isn't set yet, producing an empty string.
ENV PA_PROVIDER_BASE_URL=https://api.featherless.ai/v1
ENV PA_PROVIDER_MODEL=Qwen/Qwen3-32B

EXPOSE 8080

CMD ["sh", "-c", "export PA_PROVIDER_API_KEY=\"${FEATHERLESS_API_KEY}\" && exec npm run start --workspace @commons-crew/crew-api"]