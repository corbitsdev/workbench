import { describe, expect, it } from "bun:test";
import { defaultDirectorFactory } from "@intx/agent";
import {
  createWorkbenchDirectorRegistry,
  firecrawlDirector,
  granolaDirector,
  personalAgentDirector,
} from "./director-registry";

describe("createWorkbenchDirectorRegistry", () => {
  it("resolves every Workbench director id", () => {
    const registry = createWorkbenchDirectorRegistry();
    for (const id of [
      "@workbench/agents/personal-agent",
      "@workbench/agents/granola",
      "@workbench/agents/firecrawl",
    ]) {
      expect(registry.resolve({ id, config: { allowedSenders: [] } }).id).toBe(
        id,
      );
    }
  });

  it("falls back to the interchange default for an agent without a director ref", () => {
    const registry = createWorkbenchDirectorRegistry();
    expect(registry.buildDefaultRef().id).toBe(defaultDirectorFactory.id);
    expect(registry.defaultFactory().id).toBe(defaultDirectorFactory.id);
  });

  it("throws for an unknown director id", () => {
    const registry = createWorkbenchDirectorRegistry();
    expect(() =>
      registry.resolve({ id: "@workbench/agents/nope", config: {} }),
    ).toThrow();
  });
});

describe("director build() refs", () => {
  it("stamps the id and config into a sender-filter ref", () => {
    const ref = personalAgentDirector.build({
      allowedSenders: ["ada@workbench.dev"],
    });
    expect(ref).toEqual({
      id: "@workbench/agents/personal-agent",
      config: { allowedSenders: ["ada@workbench.dev"] },
    });
  });

  it("stamps the granola id into its ref", () => {
    expect(granolaDirector.build({ allowedSenders: [] }).id).toBe(
      "@workbench/agents/granola",
    );
  });

  it("builds the firecrawl director from an empty config", () => {
    expect(firecrawlDirector.build({}).id).toBe("@workbench/agents/firecrawl");
  });
});
