import type { EvalRunResult } from "../types.ts";

export interface EvalRunStore {
  save(result: EvalRunResult): Promise<string>;
  recent(evalName: string, limit: number): Promise<EvalRunResult[]>;
}
