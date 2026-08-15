import { describe, expect, test } from "bun:test";

import {
  definitionsById,
  filterDefinitions,
  filterInstances,
  isOrphanedInstance,
  purposeAgentDefinitions,
  purposeAgentInstances,
} from "./client";

const researcher = {
  id: "wfd_1",
  name: "Researcher",
  description: "Answers research questions",
};

const channelHostDefinition = {
  ...researcher,
  id: "wfd_2",
  name: "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  description: null,
};

const instance = {
  id: "ins_1",
  definitionId: "wfd_1",
  definitionName: "Researcher",
};

const channelHostInstance = {
  ...instance,
  id: "ins_2",
  definitionId: "wfd_2",
  definitionName: "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
};

describe("purposeAgentDefinitions", () => {
  test("drops the chat anchor machinery's channel-host definitions", () => {
    const result = purposeAgentDefinitions([researcher, channelHostDefinition]);
    expect(result).toEqual([researcher]);
  });
});

describe("purposeAgentInstances", () => {
  test("drops channel-host instances", () => {
    const result = purposeAgentInstances([instance, channelHostInstance]);
    expect(result).toEqual([instance]);
  });
});

describe("filterDefinitions", () => {
  test("matches by name", () => {
    expect(filterDefinitions([researcher], "research")).toEqual([researcher]);
  });

  test("matches by description", () => {
    expect(filterDefinitions([researcher], "questions")).toEqual([researcher]);
  });

  test("is case-insensitive", () => {
    expect(filterDefinitions([researcher], "RESEARCHER")).toEqual([researcher]);
  });

  test("excludes a definition matching neither field", () => {
    expect(filterDefinitions([researcher], "nonexistent")).toEqual([]);
  });

  test("an empty query returns everything unfiltered", () => {
    expect(filterDefinitions([researcher], "  ")).toEqual([researcher]);
  });

  test("never matches on the raw id", () => {
    expect(filterDefinitions([researcher], "wfd_1")).toEqual([]);
  });
});

describe("filterInstances", () => {
  test("matches by the instance's definition name", () => {
    expect(filterInstances([instance], "research")).toEqual([instance]);
  });

  test("never matches on the raw id", () => {
    expect(filterInstances([instance], "ins_1")).toEqual([]);
  });

  test("preserves extra fields callers have attached", () => {
    const augmented = { ...instance, orphaned: false } as const;
    expect(filterInstances([augmented], "research")).toEqual([augmented]);
  });
});

describe("orphan detection", () => {
  test("an instance whose definition is present is not orphaned", () => {
    const byId = definitionsById([researcher]);
    expect(isOrphanedInstance(instance, byId)).toBe(false);
  });

  test("an instance whose definition is absent is orphaned", () => {
    const byId = definitionsById([researcher]);
    const orphan = { ...instance, definitionId: "wfd_gone" };
    expect(isOrphanedInstance(orphan, byId)).toBe(true);
  });
});
