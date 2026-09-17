export { chainFor, chainNote, readBenchCatalog, type BenchCatalog } from "./chain";
export { fetchCatalog, fetchModelPolicy, type CatalogToolClientConfig } from "./client";
export {
  catalogTools,
  describeChain,
  ESTIMATE_RUN_COST_TOOL,
  LIST_MODEL_CONCEPTS_TOOL,
  PICK_MODELS_TOOL,
  type WorkflowCatalogEnv,
} from "./tool";
// The three read-only tools resolve the chain in the workflow child from
// two stock Interchange tenant reads — `/api/tenants/:tenantId/models` and
// `/api/tenants/:tenantId` — with the run's own bearer credential. There is
// no `/api/workflow-inference-catalog` mount any more. Catalog
// administration stays UI-only (CL-7588): this package exposes no write
// tools and no hub routes.
