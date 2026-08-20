import { describe, expect, test } from "bun:test";

import { pricing } from "../test/fixtures";
import {
  groupPricingByOffering,
  perMTok,
  priceForOffering,
  referenceCostUsd,
} from "./price";

const ASOF = new Date("2026-06-01T00:00:00.000Z");

describe("perMTok", () => {
  test("scales a per-token decimal string to USD per million tokens", () => {
    expect(perMTok("0.000003")).toBeCloseTo(3, 10);
  });

  test("returns null for an absent price rather than zero", () => {
    expect(perMTok(null)).toBeNull();
  });

  test("returns null for a value that is not a number", () => {
    expect(perMTok("free")).toBeNull();
  });
});

describe("priceForOffering", () => {
  test("takes the latest row at or before asOf", () => {
    const price = priceForOffering(
      [
        pricing({
          offeringId: "o1",
          inputUsdPerMTok: 3,
          outputUsdPerMTok: 15,
          effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        }),
        pricing({
          offeringId: "o1",
          inputUsdPerMTok: 2,
          outputUsdPerMTok: 10,
          effectiveFrom: new Date("2026-05-01T00:00:00.000Z"),
        }),
        pricing({
          offeringId: "o1",
          inputUsdPerMTok: 99,
          outputUsdPerMTok: 99,
          effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
        }),
      ],
      ASOF,
      "USD",
    );
    expect(price.inputUsdPerMTok).toBeCloseTo(2, 10);
    expect(price.outputUsdPerMTok).toBeCloseTo(10, 10);
    expect(price.known).toBe(true);
  });

  test("a row in another currency is not a price in this one", () => {
    const price = priceForOffering(
      [
        pricing({
          offeringId: "o1",
          inputUsdPerMTok: 3,
          outputUsdPerMTok: 15,
          currency: "EUR",
        }),
      ],
      ASOF,
      "USD",
    );
    expect(price).toEqual({
      currency: "USD",
      known: false,
      inputUsdPerMTok: null,
      outputUsdPerMTok: null,
    });
  });

  test("no rows at all is unknown, never zero", () => {
    const price = priceForOffering([], ASOF, "USD");
    expect(price.known).toBe(false);
    expect(price.inputUsdPerMTok).toBeNull();
  });

  test("a half-priced row is not a known price", () => {
    const price = priceForOffering(
      [
        pricing({
          offeringId: "o1",
          inputUsdPerMTok: 3,
          outputUsdPerMTok: null,
        }),
      ],
      ASOF,
      "USD",
    );
    expect(price.known).toBe(false);
  });
});

describe("referenceCostUsd", () => {
  test("weights the two axes by the concept's mix", () => {
    const price = priceForOffering(
      [pricing({ offeringId: "o1", inputUsdPerMTok: 3, outputUsdPerMTok: 15 })],
      ASOF,
      "USD",
    );
    expect(
      referenceCostUsd(price, { inputMTok: 2, outputMTok: 0.5 }),
    ).toBeCloseTo(13.5, 6);
  });

  test("an unknown price has no reference cost", () => {
    expect(
      referenceCostUsd(
        {
          currency: "USD",
          known: false,
          inputUsdPerMTok: null,
          outputUsdPerMTok: null,
        },
        { inputMTok: 1, outputMTok: 1 },
      ),
    ).toBeNull();
  });
});

describe("groupPricingByOffering", () => {
  test("keeps every row for an offering together", () => {
    const grouped = groupPricingByOffering([
      pricing({ offeringId: "o1", inputUsdPerMTok: 1, outputUsdPerMTok: 2 }),
      pricing({
        offeringId: "o1",
        inputUsdPerMTok: 1,
        outputUsdPerMTok: 2,
        effectiveFrom: new Date("2026-02-01T00:00:00.000Z"),
      }),
      pricing({ offeringId: "o2", inputUsdPerMTok: 1, outputUsdPerMTok: 2 }),
    ]);
    expect(grouped.get("o1")?.length).toBe(2);
    expect(grouped.get("o2")?.length).toBe(1);
  });
});
