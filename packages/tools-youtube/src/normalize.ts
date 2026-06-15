import type { YouTubeSearchItem, YouTubeVideoStatistics } from './types';

export function normalizeYouTubeVideo(
  item: YouTubeSearchItem,
  stats: YouTubeVideoStatistics | undefined
) {
  const videoId = item.id.videoId;
  return {
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: item.snippet.title,
    publishedAt: item.snippet.publishedAt,
    source: 'youtube' as const,
    engagement: {
      upvotes: stats?.likeCount !== undefined ? parseInt(stats.likeCount, 10) : 0,
      comments: stats?.commentCount !== undefined ? parseInt(stats.commentCount, 10) : 0,
      views: stats?.viewCount !== undefined ? parseInt(stats.viewCount, 10) : 0,
    },
    author: item.snippet.channelTitle,
  };
}
