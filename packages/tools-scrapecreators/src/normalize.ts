import type {
  TikTokPost,
  InstagramPost,
  ThreadsPost,
  PinterestPin,
} from "./types";

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

function firstLine(text: string): string {
  const newlineIndex = text.indexOf("\n");
  if (newlineIndex === -1) {
    return text;
  }
  return text.slice(0, newlineIndex);
}

// Unix-second epochs are ~1e9-1e10; values at millisecond magnitude (>= 1e12)
// are already in ms and must not be multiplied again.
function epochToIso(epoch: number): string {
  const millis = epoch >= 1e12 ? epoch : epoch * 1000;
  return new Date(millis).toISOString();
}

function toIsoDate(value: number | string | undefined): string {
  if (typeof value === "number") {
    return epochToIso(value);
  }
  if (typeof value === "string" && value.length > 0) {
    if (/^\d+$/.test(value)) {
      return epochToIso(Number(value));
    }
    return value;
  }
  return new Date().toISOString();
}

export function normalizeTikTokPost(item: TikTokPost) {
  const caption = item.desc ?? "";
  return {
    url: item.url ?? `https://www.tiktok.com/@unknown/video/${item.id}`,
    title: truncate(caption, 100),
    summary: truncate(caption, 200),
    publishedAt: toIsoDate(item.createTime),
    source: "tiktok" as const,
    engagement: {
      upvotes: item.likes ?? 0,
      comments: item.comments ?? 0,
    },
    author: item.author ?? "",
  };
}

export function normalizeInstagramPost(item: InstagramPost) {
  const caption = item.caption ?? "";
  return {
    url:
      item.code !== undefined
        ? `https://www.instagram.com/reel/${item.code}`
        : "https://instagram.com",
    title: firstLine(caption),
    summary: caption,
    publishedAt: toIsoDate(item.takenAt),
    source: "instagram" as const,
    engagement: {
      upvotes: item.likes ?? 0,
      comments: item.comments ?? 0,
    },
    author: item.author ?? "",
  };
}

export function normalizeThreadsPost(item: ThreadsPost) {
  const text = item.text ?? "";
  return {
    url:
      item.code !== undefined
        ? `https://www.threads.net/t/${item.code}`
        : "https://www.threads.net",
    title: truncate(firstLine(text), 100),
    summary: text,
    publishedAt:
      item.taken_at !== undefined
        ? new Date(item.taken_at * 1000).toISOString()
        : new Date().toISOString(),
    source: "threads" as const,
    engagement: {
      upvotes: item.like_count ?? 0,
      comments: 0,
    },
    author: item.user?.username ?? "",
  };
}

export function normalizePinterestPin(item: PinterestPin) {
  const description = item.description ?? "";
  const title = item.title ?? firstLine(description);
  return {
    url:
      item.id !== undefined
        ? `https://pinterest.com/pin/${item.id}`
        : "https://pinterest.com",
    title,
    summary: description,
    publishedAt: toIsoDate(item.created_at),
    source: "pinterest" as const,
    engagement: {
      upvotes: item.save_count ?? 0,
      comments: 0,
    },
    author: item.pinner?.username ?? "",
  };
}
