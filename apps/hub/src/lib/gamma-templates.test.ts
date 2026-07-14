import { describe, expect, it, mock } from "bun:test";
import type { DB } from "@intx/db";
import { configToRow, listLatestGammaTemplates } from "./gamma-templates";

// Builds a db whose select() chain resolves to `rows` when awaited/orderBy'd.
// biome-ignore lint/suspicious/noExplicitAny: structural mock
function makeSelectDb(rows: unknown[]): any {
  const builder = {
    from: mock(() => builder),
    innerJoin: mock(() => builder),
    where: mock(() => builder),
    orderBy: mock(() => Promise.resolve(rows)),
    // biome-ignore lint/suspicious/noThenProperty: thenable mock for Drizzle
    then: (resolve: (v: unknown[]) => void) => resolve(rows),
  };
  return { select: mock(() => builder) };
}

describe("configToRow", () => {
  const BASE = {
    templateId: "tpl-1",
    version: 1,
    name: "Sales Deck",
    authorId: "prn-author",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  it("returns a well-formed row when config is valid", () => {
    const row = configToRow(
      BASE.templateId,
      BASE.version,
      BASE.name,
      {
        gammaId: "g-abc",
        description: "Quarterly sales deck",
      },
      BASE.authorId,
      BASE.createdAt,
    );

    expect(row.id).toBe("tpl-1");
    expect(row.gammaId).toBe("g-abc");
    expect(row.description).toBe("Quarterly sales deck");
    expect(row.authorId).toBe("prn-author");
    expect(row.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("falls back to legacy systemPrompt when description is absent", () => {
    const row = configToRow(
      BASE.templateId,
      BASE.version,
      BASE.name,
      {
        gammaId: "g-abc",
        systemPrompt: "You are a deck generator.",
      },
      BASE.authorId,
      BASE.createdAt,
    );

    expect(row.description).toBe("You are a deck generator.");
  });

  it("prefers description over legacy systemPrompt when both present", () => {
    const row = configToRow(
      BASE.templateId,
      BASE.version,
      BASE.name,
      {
        gammaId: "g-abc",
        description: "Human label",
        systemPrompt: "Legacy prompt",
      },
      BASE.authorId,
      BASE.createdAt,
    );

    expect(row.description).toBe("Human label");
  });

  it("returns empty description when neither field is present", () => {
    const row = configToRow(
      BASE.templateId,
      BASE.version,
      BASE.name,
      { gammaId: "g-abc" },
      BASE.authorId,
      BASE.createdAt,
    );

    expect(row.description).toBe("");
  });

  it("returns empty description when both fields are non-strings", () => {
    const row = configToRow(
      BASE.templateId,
      BASE.version,
      BASE.name,
      { gammaId: "g-abc", description: 42, systemPrompt: { a: 1 } },
      BASE.authorId,
      BASE.createdAt,
    );

    expect(row.description).toBe("");
  });

  it("surfaces systemPrompt as its own row field, independent of the description fallback", () => {
    const row = configToRow(
      BASE.templateId,
      BASE.version,
      BASE.name,
      {
        gammaId: "g-abc",
        description: "Human label",
        systemPrompt: "Use a formal, security-audience tone.",
      },
      BASE.authorId,
      BASE.createdAt,
    );

    expect(row.description).toBe("Human label");
    expect(row.systemPrompt).toBe("Use a formal, security-audience tone.");
  });

  it("defaults systemPrompt to empty string when config carries none", () => {
    const row = configToRow(
      BASE.templateId,
      BASE.version,
      BASE.name,
      { gammaId: "g-abc", description: "A label" },
      BASE.authorId,
      BASE.createdAt,
    );

    expect(row.systemPrompt).toBe("");
  });

  it("throws when gammaId is missing from config", () => {
    expect(() =>
      configToRow(
        BASE.templateId,
        BASE.version,
        BASE.name,
        { description: "A label" },
        BASE.authorId,
        BASE.createdAt,
      ),
    ).toThrow("gammaId must be a non-empty string");
  });

  it("throws when gammaId is an empty string", () => {
    expect(() =>
      configToRow(
        BASE.templateId,
        BASE.version,
        BASE.name,
        { gammaId: "", description: "A label" },
        BASE.authorId,
        BASE.createdAt,
      ),
    ).toThrow("gammaId must be a non-empty string");
  });

  it("throws when gammaId is not a string", () => {
    expect(() =>
      configToRow(
        BASE.templateId,
        BASE.version,
        BASE.name,
        { gammaId: 42, description: "A label" },
        BASE.authorId,
        BASE.createdAt,
      ),
    ).toThrow("gammaId must be a non-empty string");
  });
});

describe("listLatestGammaTemplates", () => {
  // Note: the skip path logs a WRN via @intx/log as a side effect. It is not
  // asserted here — the lib binds its logger at module-eval and static ESM
  // imports hoist above any mock.module, so the logger can't be reliably
  // intercepted in-process. The load-bearing behavior (degrade, don't poison)
  // is asserted directly: the bad row is dropped, the good row survives.
  it("skips a row with a missing gammaId and returns only the good rows", async () => {
    const db = makeSelectDb([
      {
        id: "tpl-good",
        version: 1,
        name: "Good Deck",
        config: { gammaId: "g-1", description: "ok" },
        authorId: "prn-a",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: "tpl-bad",
        version: 1,
        name: "Corrupt Deck",
        config: { description: "no gammaId here" },
        authorId: "prn-b",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
    ]);

    const rows = await listLatestGammaTemplates(db as DB["db"], "tn-1");

    expect(rows.map((r) => r.id)).toEqual(["tpl-good"]);
  });

  it("propagates an unexpected (non-config) error rather than swallowing it", async () => {
    // A select() that rejects models an infra fault; degrade-per-row must not
    // hide it.
    const builder = {
      from: mock(() => builder),
      innerJoin: mock(() => builder),
      where: mock(() => builder),
      orderBy: mock(() => Promise.reject(new Error("connection reset"))),
      // biome-ignore lint/suspicious/noThenProperty: thenable mock for Drizzle
      then: (_r: unknown, reject: (e: unknown) => void) =>
        reject(new Error("connection reset")),
    };
    // biome-ignore lint/suspicious/noExplicitAny: structural mock
    const db: any = { select: mock(() => builder) };

    await expect(
      listLatestGammaTemplates(db as DB["db"], "tn-1"),
    ).rejects.toThrow("connection reset");
  });
});
