// Round-trip coverage for "save current setup as a profile": a captured
// profile's entries applied straight back to the same workbench state
// should plan every entry as already "set-here" (a no-op reorder at its
// own position), never skipped — capture and apply agree on shape.
import { describe, expect, test } from "bun:test";

import { applyProfile } from "../src/apply";
import { captureProfileFromWorkbench } from "../src/capture";
import { createInMemoryConfigProfileStore } from "../src/store";

const models = [
  {
    id: "mdl_1",
    canonicalName: "gpt-5",
    offerings: [
      {
        offeringId: "ofr_openai",
        providerId: "prv_openai",
        providerName: "OpenAI",
        plugin: "openai",
        priority: 0,
        deploymentTags: [],
        capabilities: [],
        pricing: [],
      },
    ],
  },
];

const ownOfferings = [
  {
    id: "ofr_openai",
    tenantId: "wbn_1",
    modelId: "mdl_1",
    providerId: "prv_openai",
    priority: 0,
    deploymentTags: [],
    capabilities: [],
    quirks: null,
    disabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

function fakeFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify(models), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/catalog/offerings")) {
      return new Response(
        JSON.stringify({ data: ownOfferings, nextCursor: null }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (init?.method === "PATCH") {
      const body = JSON.parse(init.body as string) as {
        priority: number;
        disabled: boolean;
      };
      return new Response(
        JSON.stringify({
          id: url.split("/").pop(),
          tenantId: "wbn_1",
          modelId: "mdl_1",
          providerId: "prv_openai",
          priority: body.priority,
          deploymentTags: [],
          capabilities: [],
          quirks: null,
          disabled: body.disabled,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("capture + apply round-trip", () => {
  test("a captured profile applies cleanly back to the same workbench (no skips)", async () => {
    const store = createInMemoryConfigProfileStore();
    const capture = fakeFetch();
    const profile = await captureProfileFromWorkbench(
      { store },
      {
        tenantId: "tnt_workspace",
        workbenchTenantId: "wbn_1",
        name: "Current setup",
        createdBy: "prn_1",
        fetchImpl: capture.fetchImpl,
      },
    );
    expect(profile.entries).toEqual([{ provider: "OpenAI", model: "gpt-5" }]);

    const apply = fakeFetch();
    const result = await applyProfile(
      { store },
      {
        tenantId: "tnt_workspace",
        profileId: profile.id,
        workbenchTenantId: "wbn_1",
        fetchImpl: apply.fetchImpl,
      },
    );
    expect(result.results).toEqual([
      {
        provider: "OpenAI",
        model: "gpt-5",
        action: "reordered",
        offeringId: "ofr_openai",
        priority: 0,
        disabled: false,
      },
    ]);
  });

  test("the captured profile is persisted and independently listable/gettable", async () => {
    const store = createInMemoryConfigProfileStore();
    const { fetchImpl } = fakeFetch();
    const profile = await captureProfileFromWorkbench(
      { store },
      {
        tenantId: "tnt_workspace",
        workbenchTenantId: "wbn_1",
        name: "Current setup",
        description: "captured for a test",
        createdBy: "prn_1",
        fetchImpl,
      },
    );
    expect(await store.getProfile("tnt_workspace", profile.id)).toEqual(
      profile,
    );
    expect(profile.description).toBe("captured for a test");
    expect(await store.listProfiles("tnt_workspace")).toEqual([profile]);
  });
});
