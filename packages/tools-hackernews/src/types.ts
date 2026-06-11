export type HNPost = {
  objectID: string;
  title: string;
  url: string | undefined;
  points: number | undefined;
  num_comments: number | undefined;
  created_at_i: number;
};

export type HNSearchResponse = {
  hits: HNPost[];
};
