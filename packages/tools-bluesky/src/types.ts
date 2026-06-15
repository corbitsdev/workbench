export type BlueskyPostRecord = {
  $type: string;
  text: string;
  createdAt: string;
};

export type BlueskyAuthor = {
  did: string;
  handle: string;
  displayName?: string;
};

export type BlueskyPost = {
  uri: string;
  cid: string;
  author: BlueskyAuthor;
  record: BlueskyPostRecord;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  indexedAt: string;
};

export type BlueskySearchResponse = {
  posts: BlueskyPost[];
};
