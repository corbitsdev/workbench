import { expect, test } from "bun:test";
import { type } from "arktype";

import {
  CreateAgentDefinitionInput,
  UpdateAgentSkillsInput,
} from "../src/validation";

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

test("skills is optional and defaults to nothing when omitted", () => {
  const result = CreateAgentDefinitionInput(VALID);
  expect(result instanceof type.errors).toBe(false);
  if (!(result instanceof type.errors)) {
    expect(result.skills).toBeUndefined();
  }
});

test("a well-formed skills list parses", () => {
  const result = CreateAgentDefinitionInput({
    ...VALID,
    skills: ["web-research", "long-form-write"],
  });
  expect(result instanceof type.errors).toBe(false);
  if (!(result instanceof type.errors)) {
    expect(result.skills).toEqual(["web-research", "long-form-write"]);
  }
});

test("an empty skills list is accepted (clears attachments)", () => {
  const result = CreateAgentDefinitionInput({ ...VALID, skills: [] });
  expect(result instanceof type.errors).toBe(false);
});

test("a skill name that matches today's session-skill free-text names is accepted", () => {
  const result = CreateAgentDefinitionInput({
    ...VALID,
    skills: ["Web research", "Long-form write"],
  });
  expect(result instanceof type.errors).toBe(false);
});

test("a blank skill name is rejected", () => {
  const result = CreateAgentDefinitionInput({
    ...VALID,
    skills: ["   "],
  });
  expect(result instanceof type.errors).toBe(true);
});

test("an overlong skill name is rejected", () => {
  const result = CreateAgentDefinitionInput({
    ...VALID,
    skills: ["x".repeat(101)],
  });
  expect(result instanceof type.errors).toBe(true);
});

test("a duplicate skill name is rejected", () => {
  const result = CreateAgentDefinitionInput({
    ...VALID,
    skills: ["web-research", "web-research"],
  });
  expect(result instanceof type.errors).toBe(true);
});

test("UpdateAgentSkillsInput requires a skills array", () => {
  const result = UpdateAgentSkillsInput({});
  expect(result instanceof type.errors).toBe(true);
});

test("UpdateAgentSkillsInput accepts an empty array to clear attachments", () => {
  const result = UpdateAgentSkillsInput({ skills: [] });
  expect(result instanceof type.errors).toBe(false);
});

test("UpdateAgentSkillsInput rejects a duplicate skill name", () => {
  const result = UpdateAgentSkillsInput({
    skills: ["web-research", "web-research"],
  });
  expect(result instanceof type.errors).toBe(true);
});
