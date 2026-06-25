import {
  buildAgentCatalog,
  templateModelName,
  templateModelRequirements,
} from "@workbench/catalog";
import { AGENT_TEMPLATES } from "./templates";

export type {
  ModelPlugin,
  CatalogProviderSpec,
  CatalogModelSpec,
  CatalogOfferingSpec,
  AgentCatalogSpec,
} from "@workbench/catalog";
export { buildAgentCatalog, templateModelName, templateModelRequirements };

// The catalog for the seeded agent set, resolved at module load.
export const AGENT_CATALOG = buildAgentCatalog(AGENT_TEMPLATES);
