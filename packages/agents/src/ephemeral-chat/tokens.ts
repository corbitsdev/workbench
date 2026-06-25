/** Heuristic token estimate (chars / 4), aligned with Myra director budgeting. */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
