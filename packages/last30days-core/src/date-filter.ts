export function dateFilter<T extends { publishedAt: string }>(
  items: T[],
  { days, nowIso }: { days: number; nowIso: string }
): T[] {
  const cutoff = new Date(nowIso);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return items.filter((item) => new Date(item.publishedAt) >= cutoff);
}
