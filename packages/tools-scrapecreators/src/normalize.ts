import type { TikTokPost, InstagramPost, ThreadsPost, PinterestPin } from './types';

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

function firstLine(text: string): string {
  const newlineIndex = text.indexOf('\n');
  if (newlineIndex === -1) {
    return text;
  }
  return text.slice(0, newlineIndex);
}

export function normalizeTikTokPost(item: TikTokPost) {
  const caption = item.desc ?? '';
  return {
    url: item.webVideoUrl ?? `https://www.tiktok.com/@unknown/video/${item.id}`,
    title: truncate(caption, 100),
    summary: truncate(caption, 200),
    publishedAt:
      item.createTime !== undefined
        ? new Date(item.createTime * 1000).toISOString()
        : new Date().toISOString(),
    source: 'tiktok' as const,
    engagement: {
      upvotes: item.diggCount ?? 0,
      comments: 0,
    },
    author: item.authorMeta?.name ?? '',
  };
}

export function normalizeInstagramPost(item: InstagramPost) {
  const caption = item.caption ?? '';
  return {
    url:
      item.shortCode !== undefined
        ? `https://instagram.com/p/${item.shortCode}`
        : 'https://instagram.com',
    title: firstLine(caption),
    summary: caption,
    publishedAt: item.timestamp ?? new Date().toISOString(),
    source: 'instagram' as const,
    engagement: {
      upvotes: item.likesCount ?? 0,
      comments: 0,
    },
    author: item.ownerUsername ?? '',
  };
}

export function normalizeThreadsPost(item: ThreadsPost) {
  const text = item.text ?? '';
  return {
    url:
      item.code !== undefined
        ? `https://www.threads.net/t/${item.code}`
        : 'https://www.threads.net',
    title: truncate(firstLine(text), 100),
    summary: text,
    publishedAt:
      item.taken_at !== undefined
        ? new Date(item.taken_at * 1000).toISOString()
        : new Date().toISOString(),
    source: 'threads' as const,
    engagement: {
      upvotes: item.like_count ?? 0,
      comments: 0,
    },
    author: item.user?.username ?? '',
  };
}

export function normalizePinterestPin(item: PinterestPin) {
  const description = item.description ?? '';
  const title = item.title ?? firstLine(description);
  return {
    url: item.id !== undefined ? `https://pinterest.com/pin/${item.id}` : 'https://pinterest.com',
    title,
    summary: description,
    publishedAt: item.created_at ?? new Date().toISOString(),
    source: 'pinterest' as const,
    engagement: {
      upvotes: item.save_count ?? 0,
      comments: 0,
    },
    author: item.pinner?.username ?? '',
  };
}
