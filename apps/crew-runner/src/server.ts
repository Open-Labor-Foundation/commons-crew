import { pathToFileURL } from "node:url";
import { loadConfigOrThrow } from "../../../packages/config/src/index";
import { createRunnerApp } from "./create-app";

export { createRunnerApp } from "./create-app";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfigOrThrow();
  const app = await createRunnerApp({ config });

  await app.listen({
    host: "0.0.0.0",
    port: config.ports.runner
  });
}
