import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";

// The mocked record carries an extra `systemPrompt` (a legacy config field the
// projection must NOT leak to the model). Feeding it through proves the tool's
// explicit {gammaId,name,description} projection drops it, rather than relying
// on the mock never having produced it.
const templates = [
  {
    id: "tpl-1",
    version: 2,
    name: "Sales Deck",
    gammaId: "g-1",
    description: "Quarterly sales deck",
    authorId: "prn-author",
    createdAt: "2026-01-01T00:00:00.000Z",
    systemPrompt: "You are a deck generator.",
  },
];

mock.module("../lib/gamma-templates", () => ({
  listLatestGammaTemplates: mock(() => Promise.resolve(templates)),
}));

import { GAMMA_LIST_TEMPLATES_HUB_TOOL } from "./gamma-templates";

const TOOL_CONTEXT = {
  db: {} as HubDb,
  tenantId: "tn-1",
  principalId: "prn-1",
  agentId: "agt-1",
  sessionId: "ses-1",
};

describe("GAMMA_LIST_TEMPLATES_HUB_TOOL", () => {
  it("emits gammaId, name, and description (not systemPrompt)", async () => {
    const tools = GAMMA_LIST_TEMPLATES_HUB_TOOL.createTools(TOOL_CONTEXT);
    const tool = tools[0];
    if (!tool || tool.kind !== "string") {
      throw new Error("expected one string-kind tool");
    }

    const raw = await tool.handler({}, new AbortController().signal);
    const parsed = JSON.parse(raw) as Record<string, unknown>[];

    expect(parsed).toEqual([
      {
        gammaId: "g-1",
        name: "Sales Deck",
        description: "Quarterly sales deck",
      },
    ]);
    expect(parsed[0]).not.toHaveProperty("systemPrompt");
  });
});
