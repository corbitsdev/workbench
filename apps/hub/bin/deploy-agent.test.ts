import { describe, it, expect } from "bun:test";
import { resolveTemplate } from "./deploy-agent";
import { AGENT_TEMPLATES } from "@workbench/agents";

describe("resolveTemplate", () => {
  it("returns the matching template by key", () => {
    const oat = resolveTemplate("oat");
    expect(oat.key).toBe("oat");
    expect(oat.name).toBe("Oat");
    expect(oat).toBe(AGENT_TEMPLATES.find((t) => t.key === "oat"));
  });

  it("throws loudly on an unknown template id, listing known keys", () => {
    expect(() => resolveTemplate("nope")).toThrow(/unknown template "nope"/);
    expect(() => resolveTemplate("nope")).toThrow(/oat/);
  });
});
