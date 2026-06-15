export type TikTokPost = {
  id: string;
  url?: string;
  desc?: string;
  createTime?: number;
  likes?: number;
  comments?: number;
  author?: string;
};

export type InstagramPost = {
  code?: string;
  caption?: string;
  takenAt?: number | string;
  likes?: number;
  comments?: number;
  author?: string;
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
