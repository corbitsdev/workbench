// Thin line-based prompt helpers for the admin CLI. Kept dependency-free
// (bun's global prompt) and matching the numbered-list style already used by
// resolveTargetTenant in _lib. The selection parsers are pure and tested; the
// console wrappers are not.

// Parse a single 1-based selection against a list length. Returns the 0-based
// index, or null for empty/invalid input.
export function parseSingleSelection(
  answer: string | null,
  length: number,
): number | null {
  if (answer === null) return null;
  const trimmed = answer.trim();
  if (trimmed === "") return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(n) || n < 1 || n > length) return null;
  return n - 1;
}

export function selectOne<T>(
  label: string,
  items: T[],
  render: (item: T) => string,
): T | null {
  if (items.length === 0) return null;
  console.log(`\n${label}`);
  items.forEach((item, i) => console.log(`  ${i + 1}) ${render(item)}`));
  const index = parseSingleSelection(
    prompt(`Select [1-${items.length}]:`),
    items.length,
  );
  if (index === null) return null;
  return items[index] ?? null;
}

export function ask(question: string): string | null {
  return prompt(question);
}

export function confirm(question: string): boolean {
  const answer = prompt(`${question} [y/N]:`);
  return answer !== null && /^y(es)?$/i.test(answer.trim());
}
