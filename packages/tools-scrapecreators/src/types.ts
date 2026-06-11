export type TikTokPost = {
  id: string;
  webVideoUrl?: string;
  desc?: string;
  createTime?: number;
  diggCount?: number;
  authorMeta?: {
    name?: string;
  };
};

export type InstagramPost = {
  shortCode?: string;
  caption?: string;
  timestamp?: string;
  likesCount?: number;
  ownerUsername?: string;
};

export type ThreadsPost = {
  code?: string;
  text?: string;
  taken_at?: number;
  like_count?: number;
  user?: {
    username?: string;
  };
};

export type PinterestPin = {
  id?: string;
  title?: string;
  description?: string;
  created_at?: string;
  save_count?: number;
  pinner?: {
    username?: string;
  };
};
