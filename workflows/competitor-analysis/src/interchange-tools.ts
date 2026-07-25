// Native `interchange.tools` entry for @workbench/tools-competitor-analysis.
// Stateless (a pure field rename), so the factory touches no env keys and
// resolves no credential.

import { createToolRunner, defineTool } from "@intx/agent";
import { createCompetitorAnalysisTools } from "./tools";

export const competitorAnalysis = defineTool({
  id: "@workbench/tools-competitor-analysis/core",
  factory: () => createToolRunner(createCompetitorAnalysisTools()),
});
