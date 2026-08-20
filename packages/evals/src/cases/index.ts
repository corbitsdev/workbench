import { aiDailyResearchEval } from "./ai-daily-research.ts";
import { docsOnSdkChangeEval } from "./docs-on-sdk-change.ts";
import { githubPrReviewFactoryEval } from "./github-pr-review-factory.ts";
import type { EvalDefinition } from "../types.ts";

export { aiDailyResearchEval } from "./ai-daily-research.ts";
export { docsOnSdkChangeEval } from "./docs-on-sdk-change.ts";
export { githubPrReviewFactoryEval } from "./github-pr-review-factory.ts";

export const ALL_EVALS: readonly EvalDefinition[] = [
  aiDailyResearchEval,
  docsOnSdkChangeEval,
  githubPrReviewFactoryEval,
];
