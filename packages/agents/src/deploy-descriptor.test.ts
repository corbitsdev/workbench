import { test, expect } from "bun:test";
import { type } from "arktype";
import { AgentDeployDescriptor } from "./deploy-descriptor";

const valid = {
  label: "Freddie",
  name: "Freddie",
  systemPrompt: "You are Freddie.",
  credentialProviderNames: ["firecrawl"],
  defaultTools: ["firecrawl_scrape"],
  requiredTools: ["firecrawl_scrape"],
};

test("AgentDeployDescriptor accepts a minimal valid descriptor", () => {
  const parsed = AgentDeployDescriptor(valid);
  expect(parsed instanceof type.errors).toBe(false);
});

test("AgentDeployDescriptor accepts optional modelConfig and toolPackages", () => {
  const parsed = AgentDeployDescriptor({
    ...valid,
    modelConfig: { defaultModel: "claude-opus-4-8" },
    toolPackages: [{ name: "@workbench/tools-firecrawl", version: "^0.1.0" }],
  });
  expect(parsed instanceof type.errors).toBe(false);
});

test("AgentDeployDescriptor rejects a missing required field", () => {
  const { requiredTools, ...missing } = valid;
  void requiredTools;
  const parsed = AgentDeployDescriptor(missing);
  expect(parsed instanceof type.errors).toBe(true);
});

test("AgentDeployDescriptor rejects a non-string label", () => {
  const parsed = AgentDeployDescriptor({ ...valid, label: 42 });
  expect(parsed instanceof type.errors).toBe(true);
});

test("AgentDeployDescriptor rejects a malformed toolPackage pin name", () => {
  const parsed = AgentDeployDescriptor({
    ...valid,
    toolPackages: [{ name: "INVALID UPPERCASE", version: "^0.1.0" }],
  });
  expect(parsed instanceof type.errors).toBe(true);
});

test("AgentDeployDescriptor rejects a non-string entry in credentialProviderNames", () => {
  const parsed = AgentDeployDescriptor({
    ...valid,
    credentialProviderNames: ["ok", 7],
  });
  expect(parsed instanceof type.errors).toBe(true);
});
