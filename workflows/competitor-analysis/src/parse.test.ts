import { describe, expect, test } from "bun:test";
import {
  parseCompetitorReport,
  parseDiscoverResult,
  parseSubjectProfile,
} from "./parse";

function reply(value: unknown): { reply: string } {
  return { reply: JSON.stringify(value) };
}

const PROFILE = {
  companyName: "Acme",
  website: "https://acme.com",
  category: "mid-market CRM",
  thesis: "Acme sells CRM to mid-market sales teams.",
  icp: "VP Sales at 50-500 person companies",
  positioning: "CRM that closes itself",
  discoveryQueries: [
    "mid-market CRM competitors",
    "Acme CRM alternatives",
    "best CRM for mid-market 2026",
  ],
};

const DISCOVER = {
  subjectName: "Acme",
  category: "mid-market CRM",
  notes: "Found three direct peers with public comparison pages.",
  competitors: [
    {
      name: "HubSpot",
      website: "https://hubspot.com",
      segment: "direct",
      thesis: "Inbound CRM platform for SMBs and mid-market.",
      whyCompetes: "Same buyer, broader suite.",
      positioning: "Grow better",
      sources: [
        "https://hubspot.com",
        "https://g2.com/compare/acme-vs-hubspot",
      ],
    },
  ],
};

const REPORT = {
  title: "Acme — competitor analysis",
  content: "## Subject\nAcme is a mid-market CRM.\n\n## Competitors\n- HubSpot",
  competitors: [
    {
      name: "HubSpot",
      website: "https://hubspot.com",
      segment: "direct",
      whyCompetes: "Same buyer, broader suite.",
      positioning: "Grow better",
      sources: ["https://hubspot.com"],
    },
  ],
};

describe("parseSubjectProfile", () => {
  test("decodes a valid profile reply", () => {
    const out = parseSubjectProfile(reply(PROFILE));
    expect(out.status).toBe("ok");
    if (out.status === "ok") {
      expect(out.value.companyName).toBe("Acme");
      expect(out.value.discoveryQueries).toHaveLength(3);
    }
  });

  test("returns pending when the envelope is missing", () => {
    expect(parseSubjectProfile(undefined).status).toBe("pending");
  });

  test("returns malformed when required fields are missing", () => {
    expect(parseSubjectProfile(reply({ companyName: "Acme" })).status).toBe(
      "malformed",
    );
  });
});

describe("parseDiscoverResult", () => {
  test("decodes a valid discover reply", () => {
    const out = parseDiscoverResult(reply(DISCOVER));
    expect(out.status).toBe("ok");
    if (out.status === "ok") {
      expect(out.value.competitors[0]?.name).toBe("HubSpot");
      expect(out.value.competitors[0]?.segment).toBe("direct");
    }
  });

  test("accepts an empty competitor list", () => {
    const out = parseDiscoverResult(
      reply({ ...DISCOVER, competitors: [], notes: "No peers found." }),
    );
    expect(out.status).toBe("ok");
    if (out.status === "ok") {
      expect(out.value.competitors).toEqual([]);
    }
  });

  test("returns malformed for an invalid segment", () => {
    const bad = {
      ...DISCOVER,
      competitors: [
        {
          ...DISCOVER.competitors[0],
          segment: "frenemy",
        },
      ],
    };
    expect(parseDiscoverResult(reply(bad)).status).toBe("malformed");
  });
});

describe("parseCompetitorReport", () => {
  test("decodes a valid report reply", () => {
    const out = parseCompetitorReport(reply(REPORT));
    expect(out.status).toBe("ok");
    if (out.status === "ok") {
      expect(out.value.title).toContain("Acme");
      expect(out.value.content).toContain("Subject");
      expect(out.value.competitors).toHaveLength(1);
    }
  });

  test("returns pending for an empty reply", () => {
    expect(parseCompetitorReport({ reply: "" }).status).toBe("pending");
  });

  test("returns malformed for non-JSON reply text", () => {
    expect(parseCompetitorReport({ reply: "not json" }).status).toBe(
      "malformed",
    );
  });
});
