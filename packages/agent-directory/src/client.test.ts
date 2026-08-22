import { describe, expect, test } from "bun:test";

import {
  definitionsById,
  deriveDisplayName,
  filterDefinitions,
  filterInstances,
  humanizeSlug,
  isOrphanedInstance,
  purposeAgentDefinitions,
  purposeAgentInstances,
  withDisplayName,
  withDisplayNames,
} from "./client";

const researcher = {
  id: "wfd_1",
  name: "Researcher",
  description: "Answers research questions",
};

const workbenchHostDefinition = {
  ...researcher,
  id: "wfd_2",
  name: "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  description: null,
};

const instance = {
  id: "ins_1",
  definitionId: "wfd_1",
  definitionName: "Researcher",
  address: "ins_1@acme.localhost",
};

const workbenchHostInstance = {
  ...instance,
  id: "ins_2",
  definitionId: "wfd_2",
  definitionName: "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
};

const dailyDigestDefinition = {
  ...researcher,
  id: "wfd_3",
  name: "workbench-digest",
  description: null,
};

const last30DaysResearchDefinition = {
  ...researcher,
  id: "wfd_4",
  name: "last-30-days-research",
  description: null,
};

describe("purposeAgentDefinitions", () => {
  test("drops the chat anchor machinery's workbench-host definitions", () => {
    const result = purposeAgentDefinitions([
      researcher,
      workbenchHostDefinition,
    ]);
    expect(result).toEqual([researcher]);
  });

  test("drops routine-only workflow catalog utilities (Daily digest, Last 30 days research) — they are non-conversational, seeded as routines, and belong on the Routines page, not the Agents list", () => {
    const result = purposeAgentDefinitions([
      researcher,
      dailyDigestDefinition,
      last30DaysResearchDefinition,
    ]);
    expect(result).toEqual([researcher]);
  });
});

const invitedAgentInstance = {
  ...instance,
  id: "ins_3",
  definitionId: "wfd_1",
  definitionName: "Researcher",
};

describe("purposeAgentInstances", () => {
  test("drops workbench-host instances", () => {
    const result = purposeAgentInstances([instance, workbenchHostInstance]);
    expect(result).toEqual([instance]);
  });

  test("with no folded-run-id set, leaves an ordinary top-level deployment alone", () => {
    const result = purposeAgentInstances([instance]);
    expect(result).toEqual([instance]);
  });

  test("drops an invited-agent chat run whose id is in the folded-run-id set, even under a real definitionId", () => {
    const result = purposeAgentInstances(
      [instance, invitedAgentInstance],
      new Set([invitedAgentInstance.id]),
    );
    expect(result).toEqual([instance]);
  });

  test("still drops a workbench host when a folded-run-id set is also given", () => {
    const result = purposeAgentInstances(
      [instance, workbenchHostInstance, invitedAgentInstance],
      new Set([invitedAgentInstance.id]),
    );
    expect(result).toEqual([instance]);
  });

  test("does not exclude an ordinary deployment merely because a different id is in the set", () => {
    const result = purposeAgentInstances(
      [instance],
      new Set([invitedAgentInstance.id]),
    );
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

  test("never matches on the raw id or address", () => {
    expect(filterInstances([instance], "ins_1")).toEqual([]);
    expect(filterInstances([instance], "acme.localhost")).toEqual([]);
  });

  test("preserves extra fields callers have attached", () => {
    const augmented = { ...instance, orphaned: false } as const;
    expect(filterInstances([augmented], "research")).toEqual([augmented]);
  });
});

describe("humanizeSlug", () => {
  test("turns a hyphenated slug into Title Case words", () => {
    expect(humanizeSlug("research-analyst")).toBe("Research Analyst");
  });

  test("capitalizes a single-word slug", () => {
    expect(humanizeSlug("assist")).toBe("Assist");
  });

  test("collapses repeated separators and trims empties", () => {
    expect(humanizeSlug("outreach--bot")).toBe("Outreach Bot");
  });

  test("passes an already-prose name through with only case fixed up", () => {
    expect(humanizeSlug("triage bot")).toBe("Triage Bot");
  });
});

describe("deriveDisplayName", () => {
  test("prefers the definition's own description", () => {
    expect(
      deriveDisplayName({
        name: "research-analyst",
        description: "Research Analyst",
      }),
    ).toBe("Research Analyst");
  });

  test("backfills a humanized name when description is null", () => {
    expect(
      deriveDisplayName({ name: "research-analyst", description: null }),
    ).toBe("Research Analyst");
  });

  test("backfills a humanized name when description is missing entirely", () => {
    expect(deriveDisplayName({ name: "research-analyst" })).toBe(
      "Research Analyst",
    );
  });

  test("backfills when description is an empty string", () => {
    expect(
      deriveDisplayName({ name: "research-analyst", description: "" }),
    ).toBe("Research Analyst");
  });

  test("backfills when description is whitespace-only, never rendering a blank name", () => {
    expect(
      deriveDisplayName({ name: "research-analyst", description: "   " }),
    ).toBe("Research Analyst");
  });

  test("trims incidental whitespace around a real description", () => {
    expect(
      deriveDisplayName({
        name: "research-analyst",
        description: "  Research Analyst  ",
      }),
    ).toBe("Research Analyst");
  });

  test("throws on a malformed record instead of rendering undefined", () => {
    expect(() => deriveDisplayName({} as { name: string })).toThrow();
  });
});

describe("withDisplayName / withDisplayNames", () => {
  test("attaches a displayName without disturbing other fields", () => {
    const withName = withDisplayName(researcher);
    expect(withName).toEqual({
      ...researcher,
      displayName: researcher.description,
    });
    expect(withName.id).toBe(researcher.id);
    expect(withName.name).toBe(researcher.name);
  });

  test("maps over a list", () => {
    const result = withDisplayNames([researcher, workbenchHostDefinition]);
    expect(result.map((d) => d.displayName)).toEqual([
      researcher.description,
      humanizeSlug(workbenchHostDefinition.name),
    ]);
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
