# Configuration Migration Strategy

## Context

The commons-crew VS Code extension is a native implementation — not a fork of
Roo Code. It embeds the real commons-crew runtime (`packages/core`) in-process
inside the extension host, using the user's BYO inference key and a local JSON
store. There is no Roo Code configuration to migrate from; this document
describes how a user configures the extension from scratch.

## Step 1: Install the Extension

```bash
cd commons-crew/apps/crew-vscode
npm install
npm run build        # esbuild bundles core + provider-api + config into dist/extension.js
npm run package      # produces commons-crew.vsix
```

Install the VSIX in VS Code:
```
Extensions → ⋯ → Install from VSIX → select commons-crew.vsix
```

## Step 2: Configure Inference

Open VS Code Settings → search `commonsCrew`:

| Setting | Description | Default |
|---------|-------------|---------|
| `commonsCrew.apiKey` | Your inference API key (BYO). Required. | `""` |
| `commonsCrew.baseUrl` | OpenAI-compatible base URL. | `https://api.featherless.ai/v1` |
| `commonsCrew.model` | Model id, or `auto` for auto-selection. | `auto` |
| `commonsCrew.fallbackModels` | Ordered fallback models (ignored in auto mode). | `[]` |
| `commonsCrew.catalogRef` | labor-commons branch/ref to materialize from. | `main` |
| `commonsCrew.autoApprove` | Skip approval gate for side effects. | `false` |
| `commonsCrew.maxIterations` | Max tool-loop iterations per task. | `40` |
| `commonsCrew.maxConcurrentLanes` | Max concurrent runs (1–8). | `4` |

## Step 3: Open a Workspace Folder

The extension acts on the currently open VS Code workspace folder. The runtime
reads, writes, and runs commands in that folder — it is the runtime's real
workspace root.

## Step 4: Start Chating

Open the commons-crew activity bar icon → type a message. The runtime boots
in-process, syncs the labor-commons catalog (shallow git clone on first run),
and materializes the right specialist for your task.

## Environment Variable Mapping

The extension maps VS Code settings to the config package's `PA_*` environment
variables internally:

| VS Code Setting | Config Env Var |
|-----------------|----------------|
| `apiKey` | `PA_PROVIDER_API_KEY` |
| `baseUrl` | `PA_PROVIDER_BASE_URL` |
| `model` | `PA_PROVIDER_MODEL` |
| `fallbackModels` | `PA_PROVIDER_FALLBACK_MODELS` |
| `maxConcurrentLanes` | `PA_MAX_CONCURRENT_RUNS` |
| `maxIterations` | `PA_MAX_TOOL_STEPS` |
| `catalogRef` | (used by catalog-sync, not a PA_ var) |

The profile is always `local` (JSON store, development env).