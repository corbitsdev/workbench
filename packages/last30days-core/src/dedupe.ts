function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function engagementSum(
  engagement: { upvotes?: number; comments?: number } | undefined,
): number {
  if (engagement === undefined) return 0;
  return (engagement.upvotes ?? 0) + (engagement.comments ?? 0);
}

export function dedupe<
  T extends {
    url: string;
    title: string;
    engagement?: { upvotes?: number; comments?: number };
    source: string;
  },
>(items: T[]): T[] {
  const urlMap = new Map<string, T>();
  const titleMap = new Map<string, T>();
  const result: T[] = [];

  for (const item of items) {
    const normalizedTitle = normalizeTitle(item.title);

    const existingByUrl = urlMap.get(item.url);
    if (existingByUrl !== undefined) {
      if (
        existingByUrl.source !== item.source &&
        engagementSum(item.engagement) > engagementSum(existingByUrl.engagement)
      ) {
        urlMap.set(item.url, item);
        const idx = result.indexOf(existingByUrl);
        if (idx !== -1) result[idx] = item;
      }
      continue;
    }

    const existingByTitle = titleMap.get(normalizedTitle);
    if (existingByTitle !== undefined) {
      if (
        existingByTitle.source !== item.source &&
        engagementSum(item.engagement) >
          engagementSum(existingByTitle.engagement)
      ) {
        titleMap.set(normalizedTitle, item);
        urlMap.set(item.url, item);
        const idx = result.indexOf(existingByTitle);
        if (idx !== -1) result[idx] = item;
      }
      continue;
    }

    urlMap.set(item.url, item);
    titleMap.set(normalizedTitle, item);
    result.push(item);
  }

  return result;
}
