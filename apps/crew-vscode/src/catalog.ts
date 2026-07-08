// Catalog = live link to labor-commons (never bundled). For the coding use case
// we materialize the software-engineering specialists. Fetched over HTTP from
// the configured ref (default main) so no git or local checkout is required —
// the same portable fetch a phone would use.
//
// Parsing reuses the real commons-crew catalog parser, so a VS Code-materialized
// specialist is the exact same governed contract the runtime uses.

import { parseSpecialistManifest } from "../../../packages/catalog/src/index";
import type { SpecialistManifestContract } from "../../../packages/contracts/src/index";

const REPO = "Open-Labor-Foundation/labor-commons";
const SECTION = "catalog/naics-overlays/software-engineering-and-application-delivery";

export interface CatalogSpecialist {
  slug: string;
  manifest: SpecialistManifestContract;
}

async function listSlugs(ref: string): Promise<string[]> {
  const url = `https://api.github.com/repos/${REPO}/contents/${SECTION}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "commons-crew-vscode" } });
  if (!res.ok) {
    throw new Error(`Could not list labor-commons specialists (${res.status}). Check commonsCrew.catalogRef.`);
  }
  const entries = (await res.json()) as Array<{ name: string; type: string }>;
  return entries.filter((e) => e.type === "dir").map((e) => e.name);
}

async function fetchSpec(slug: string, ref: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(ref)}/${SECTION}/${slug}/spec.yaml`;
  const res = await fetch(url, { headers: { "user-agent": "commons-crew-vscode" } });
  if (!res.ok) {
    throw new Error(`Could not fetch spec for ${slug} (${res.status}).`);
  }
  return await res.text();
}

/** Fetch + parse the software-engineering specialists from labor-commons@ref. */
export async function loadCodingSpecialists(ref: string): Promise<CatalogSpecialist[]> {
  const slugs = await listSlugs(ref);
  const specialists: CatalogSpecialist[] = [];
  await Promise.all(
    slugs.map(async (slug) => {
      try {
        const source = await fetchSpec(slug, ref);
        const manifest = parseSpecialistManifest(source, `${SECTION}/${slug}/spec.yaml`);
        specialists.push({ slug, manifest });
      } catch {
        // Skip a spec that fails to fetch/parse rather than failing the whole load.
      }
    })
  );
  specialists.sort((a, b) => a.slug.localeCompare(b.slug));
  return specialists;
}
