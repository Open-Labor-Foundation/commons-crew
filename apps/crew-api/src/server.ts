import { createApiApp } from "./create-app";
import { ensureCatalogCheckout, resolveCatalogCheckoutConfig } from "./catalog-checkout";
import { loadConfigOrThrow } from "../../../packages/config/src/index";

const config = loadConfigOrThrow();

// Catalog = live link to labor-commons main. When CATALOG_AUTO_SYNC is enabled
// (the container default), mirror the catalog checkout before the runtime reads
// it. Fatal on first boot if the catalog can't be fetched — the runtime is
// useless without specialists.
const catalogCheckout = resolveCatalogCheckoutConfig();
if (catalogCheckout) {
  const result = await ensureCatalogCheckout(catalogCheckout);
  console.log(`[catalog] mirrored ${catalogCheckout.repoUrl}@${result.ref} (${result.commit.slice(0, 12)}) into ${catalogCheckout.dir}`);
}

const app = await createApiApp(config, { onBeforeCatalogSync: catalogCheckout
  ? async () => { await ensureCatalogCheckout(catalogCheckout); }
  : undefined });

await app.listen({
  host: "0.0.0.0",
  port: config.ports.api
});
