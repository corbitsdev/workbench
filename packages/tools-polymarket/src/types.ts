export type PolymarketMarket = {
  id: string;
  question: string;
  outcomePrices: string[];
  volume24hr: number | undefined;
  endDate: string | undefined;
  conditionId: string;
};
