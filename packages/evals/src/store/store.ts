import type { EvalRunResult } from "../types.ts";

/** An `EvalRunResult` as read back from storage, carrying the store's own
 * `id` (`evalrun_<uuid>`) — never part of `EvalRunResult` itself, since
 * that type is also what a fresh run produces before it has one. */
export interface EvalRunRecord extends EvalRunResult {
  readonly id: string;
}

export interface EvalRunStore {
  save(result: EvalRunResult): Promise<string>;
  recent(evalName: string, limit: number): Promise<EvalRunRecord[]>;
  /** Most recent runs across every eval, newest first — the read
   * route's list view. */
  recentAcrossEvals(limit: number): Promise<EvalRunRecord[]>;
  /** One run by its store id, or `null` if no such run exists. */
  get(id: string): Promise<EvalRunRecord | null>;
}
