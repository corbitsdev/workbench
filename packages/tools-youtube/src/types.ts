export type YouTubeSearchItem = {
  id: {
    kind: string;
    videoId: string;
  };
  snippet: {
    publishedAt: string;
    title: string;
    description: string;
    channelTitle: string;
  };
};

export type YouTubeSearchResponse = {
  items: YouTubeSearchItem[];
};

export type YouTubeVideoStatistics = {
  viewCount: string | undefined;
  likeCount: string | undefined;
  commentCount: string | undefined;
};

export type YouTubeVideoItem = {
  id: string;
  statistics: YouTubeVideoStatistics;
};

export type YouTubeVideosResponse = {
  items: YouTubeVideoItem[];
};
