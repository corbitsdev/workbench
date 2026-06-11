export type XSearchResult = {
  title: string;
  url: string | undefined;
  summary: string;
  publishedAt: string | undefined;
  engagementSignal: string | undefined;
};

export type XSearchResponse = {
  results: XSearchResult[];
};
