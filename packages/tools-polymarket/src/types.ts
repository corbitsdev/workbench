import { type } from "arktype";

export const PolymarketMarket = type({
  id: "string",
  question: "string",
  outcomePrices: "string[]",
  "volume24hr?": "number",
  "endDate?": "string",
  conditionId: "string",
});

export type PolymarketMarket = typeof PolymarketMarket.infer;
