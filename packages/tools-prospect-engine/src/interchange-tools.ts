import { createToolRunner, defineTool } from "@intx/agent";
import { createProspectEngineTools } from "./tools";

export const prospectEngine = defineTool({
  id: "@workbench/tools-prospect-engine/core",
  factory: () => createToolRunner(createProspectEngineTools()),
});

export {
  prospectEngineLedgerBridge,
  prospectEngineMailBridge,
} from "./tolerant-bridges";
