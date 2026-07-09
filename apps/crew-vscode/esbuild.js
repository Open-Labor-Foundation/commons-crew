const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const watch = process.argv.includes("--watch");

// Bundle the real commons-crew runtime (core/provider-api/config/contracts) into
// the extension. The prompt-governance artifacts the runtime loads from repoRoot
// are copied into the extension install dir so repoRoot === extensionUri works.
function copyGovernance() {
  const from = path.resolve(__dirname, "../../governance");
  const to = path.resolve(__dirname, "governance");
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(`copied governance/ (${fs.readdirSync(path.join(to, "prompts")).length} prompt files)`);
}

async function main() {
  copyGovernance();
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    // `vscode` is provided by the extension host. `pg-native` is pg's optional
    // native binding (never used — the local profile uses the json store). The
    // rest, including the commons-crew runtime, is bundled.
    external: ["vscode", "pg-native"],
    sourcemap: true,
    logLevel: "info"
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
