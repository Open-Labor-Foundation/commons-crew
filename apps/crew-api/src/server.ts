import { createApiApp } from "./create-app";
import { loadConfigOrThrow } from "../../../packages/config/src/index";

const config = loadConfigOrThrow();
const app = await createApiApp(config);

await app.listen({
  host: "0.0.0.0",
  port: config.ports.api
});
