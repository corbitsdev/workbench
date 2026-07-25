import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCommittedToolManifestFactories } from "../src/committed-index";
import {
  deriveMyraCatalogPackages,
  derivePackageProviders,
  derivePackageTools,
} from "../src/derive";

const root = join(import.meta.dir, "..", "..", "..");
const factories = loadCommittedToolManifestFactories();
const out = {
  packageTools: derivePackageTools(factories),
  packageProviders: derivePackageProviders(factories),
  myraCatalog: deriveMyraCatalogPackages(factories),
  toolPackageNames: [...new Set(factories.map((f) => f.packageName))].sort(),
};
writeFileSync(
  join(root, "apps/hub/generated/tool-manifests/legacy-baseline.json"),
  `${JSON.stringify(out, null, 2)}\n`,
  "utf8",
);
