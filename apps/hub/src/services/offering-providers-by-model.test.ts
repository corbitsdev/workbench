import { describe, expect, mock, test } from "bun:test";

const listVisibleOfferings = mock(
  async (): Promise<
    Array<{
      offering: { id: string; priority: number };
      model: { canonicalName: string };
      provider: { name: string };
      origin: { tenantId: string; direct: boolean };
    }>
  > => [],
);

mock.module("@intx/db", () => ({
  listVisibleOfferings,
}));

const { getOfferingProvidersByModel } = await import(
  "./offering-providers-by-model"
);

describe("getOfferingProvidersByModel", () => {
  test("groups visible offerings by canonical model", async () => {
    listVisibleOfferings.mockResolvedValueOnce([
      {
        offering: { id: "off_1", priority: 0 },
        model: { canonicalName: "deepseek-v4-flash" },
        provider: { name: "opencode-zen" },
        origin: { tenantId: "ten_1", direct: true },
      },
      {
        offering: { id: "off_2", priority: 1 },
        model: { canonicalName: "deepseek-v4-flash" },
        provider: { name: "opencode-zen" },
        origin: { tenantId: "ten_1", direct: true },
      },
      {
        offering: { id: "off_3", priority: 0 },
        model: { canonicalName: "claude-opus-4-5" },
        provider: { name: "anthropic-api" },
        origin: { tenantId: "ten_1", direct: true },
      },
    ]);
    const map = await getOfferingProvidersByModel({} as never, "ten_1");
    expect(map).toEqual({
      "deepseek-v4-flash": ["opencode-zen"],
      "claude-opus-4-5": ["anthropic-api"],
    });
  });
});
