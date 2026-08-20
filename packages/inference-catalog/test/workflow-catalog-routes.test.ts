import { describe, expect, test } from "bun:test";

import { createWorkflowCatalogRoutes } from "../src/workflow-catalog-routes";
import { EMPTY_POLICY, type BenchModelPolicy } from "../src/policy";
import { offering, pricing } from "./fixtures";

const ASOF = new Date("2026-06-01T00:00:00.000Z");
const TOKEN = "sidecar-token";
const ADDRESS = "run-address";

const OFFERINGS = [
  offering({
    id: "cheap",
    canonicalName: "thrifty",
    displayName: "Thrifty",
    providerName: "globex",
    capabilities: ["plain-text", "structured-output"],
  }),
  offering({
    id: "dear",
    canonicalName: "lavish",
    displayName: "Lavish",
    providerName: "acme",
    capabilities: ["plain-text", "structured-output"],
  }),
];

const PRICING = [
  pricing({ offeringId: "cheap", inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.4 }),
  pricing({ offeringId: "dear", inputUsdPerMTok: 4, outputUsdPerMTok: 20 }),
];

function routes(policy: BenchModelPolicy = EMPTY_POLICY) {
  return createWorkflowCatalogRoutes({
    authenticator: {
      resolve: async (token, address) =>
        token === TOKEN && address === ADDRESS
          ? { tenantId: "bench-1", principalId: "p1", runId: "r1" }
          : null,
    },
    listOfferings: async () => OFFERINGS,
    listPricing: async () => PRICING,
    getPolicy: async () => policy,
    now: () => ASOF,
  });
}

function post(path: string, body: unknown): Request {
  return new Request(`http://hub${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-workflow-run-address": ADDRESS,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("workflow inference-catalog routes", () => {
  test("a request without a recognized run is refused", async () => {
    const response = await routes().request("http://hub/concepts", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(response.status).toBe(401);
  });

  test("GET /concepts says how many models this bench has for each", async () => {
    const response = await routes().request("http://hub/concepts", {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-workflow-run-address": ADDRESS,
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        id: string;
        whenToUse: string;
        availableModels: number;
        headProvider: string | null;
      }[];
    };
    const cheapLoop = body.data.find((entry) => entry.id === "cheap-loop");
    expect(cheapLoop?.availableModels).toBe(2);
    expect(cheapLoop?.headProvider).toBe("globex");
    const imageMaker = body.data.find((entry) => entry.id === "image-maker");
    expect(imageMaker?.availableModels).toBe(0);
    expect(imageMaker?.headProvider).toBeNull();
  });

  test("POST /chain answers cheapest first, with the fallback behind it", async () => {
    const response = await routes().request(
      post("/chain", { concept: "cheap-loop" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      concept: string;
      entries: { canonicalName: string; overCeiling: boolean }[];
      note: string | null;
    };
    expect(body.concept).toBe("cheap-loop");
    expect(body.entries.map((entry) => entry.canonicalName)).toEqual([
      "thrifty",
      "lavish",
    ]);
    expect(body.entries[1]?.overCeiling).toBe(true);
    expect(body.note).toBe(
      "some of these cost more than this bench's ceiling for that kind of work",
    );
  });

  test("naming both a concept and capabilities is refused, and says so", async () => {
    const response = await routes().request(
      post("/chain", { concept: "cheap-loop", capabilities: ["plain-text"] }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("exactly one");
  });

  test("naming neither is refused too", async () => {
    const response = await routes().request(post("/chain", {}));
    expect(response.status).toBe(400);
  });

  test("a capability outside the platform vocabulary is refused at the boundary", async () => {
    const response = await routes().request(
      post("/chain", { capabilities: ["telepathy"] }),
    );
    expect(response.status).toBe(400);
  });

  test("an unknown concept comes back naming the real ones", async () => {
    const response = await routes().request(
      post("/chain", { concept: "vibes-based" }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("cheap-loop");
  });

  test("POST /estimate prices the work before it is spent", async () => {
    const response = await routes().request(
      post("/estimate", {
        concept: "cheap-loop",
        expectedInputTokens: 1_000_000,
        expectedOutputTokens: 100_000,
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      estimates: { canonicalName: string; estimatedUsd: number | null }[];
    };
    expect(body.estimates[0]?.canonicalName).toBe("thrifty");
    expect(body.estimates[0]?.estimatedUsd).toBeCloseTo(0.14, 6);
  });
});
