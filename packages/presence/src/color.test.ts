import { describe, expect, test } from "bun:test";
import { colorForPrincipal } from "./color";

describe("colorForPrincipal", () => {
  test("is deterministic for the same principal", () => {
    expect(colorForPrincipal("prn_alice")).toBe(colorForPrincipal("prn_alice"));
  });

  test("differs across distinct principals", () => {
    expect(colorForPrincipal("prn_alice")).not.toBe(
      colorForPrincipal("prn_bob"),
    );
  });

  test("never lands in the brand accent's orange band", () => {
    for (const principalId of ["prn_a", "prn_b", "prn_c", "prn_d", "prn_e"]) {
      const [hue] = colorForPrincipal(principalId).match(/\d+/) ?? [];
      const value = Number(hue);
      const distance = Math.min(
        Math.abs(value - 28),
        360 - Math.abs(value - 28),
      );
      expect(distance).toBeGreaterThanOrEqual(20);
    }
  });
});
