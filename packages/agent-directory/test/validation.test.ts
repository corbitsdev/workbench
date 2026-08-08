import { expect, test } from "bun:test";
import { type } from "arktype";

import { CreateAgentDefinitionInput } from "../src/validation";

const VALID = {
  name: "Research Buddy",
  handle: "research-buddy",
  systemPrompt: "You are a careful research assistant.",
} as const;

test("a well-formed submission parses", () => {
  const result = CreateAgentDefinitionInput(VALID);
  expect(result instanceof type.errors).toBe(false);
});

test("a blank name is rejected, not silently trimmed to empty", () => {
  const result = CreateAgentDefinitionInput({ ...VALID, name: "   " });
  expect(result instanceof type.errors).toBe(true);
});

test("a handle with uppercase letters is rejected", () => {
  const result = CreateAgentDefinitionInput({
    ...VALID,
    handle: "Research-Buddy",
  });
  expect(result instanceof type.errors).toBe(true);
});

test("a handle with a leading hyphen is rejected", () => {
  const result = CreateAgentDefinitionInput({
    ...VALID,
    handle: "-research-buddy",
  });
  expect(result instanceof type.errors).toBe(true);
});

test("an overlong system prompt is rejected", () => {
  const result = CreateAgentDefinitionInput({
    ...VALID,
    systemPrompt: "x".repeat(8001),
  });
  expect(result instanceof type.errors).toBe(true);
});

test("a blank system prompt is rejected", () => {
  const result = CreateAgentDefinitionInput({ ...VALID, systemPrompt: "  " });
  expect(result instanceof type.errors).toBe(true);
});

test("description and model are optional", () => {
  const result = CreateAgentDefinitionInput(VALID);
  expect(result instanceof type.errors).toBe(false);
});

test("a whitespace-only model is rejected rather than accepted as unset", () => {
  const result = CreateAgentDefinitionInput({ ...VALID, model: "   " });
  expect(result instanceof type.errors).toBe(true);
});
