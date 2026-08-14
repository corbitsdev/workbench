import { describe, expect, test } from "bun:test";

import { listSkills, loadSkill, searchSkills } from "./client";

const CONFIG = {
  hubSkillsUrl: "https://hub.example",
  sidecarToken: "sidecar-token",
  runAddress: "run@runs.example",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("listSkills", () => {
  test("calls the workflow-skills surface with the run's own credentials", async () => {
    let seen: { url: string; headers: Headers } | null = null;
    const skills = await listSkills({
      ...CONFIG,
      fetchImpl: async (input, init) => {
        seen = {
          url: String(input),
          headers: new Headers(init?.headers),
        };
        return jsonResponse({
          data: [{ name: "triage", description: "Sorts issues." }],
        });
      },
    });
    expect(skills).toEqual([{ name: "triage", description: "Sorts issues." }]);
    const call = seen as unknown as { url: string; headers: Headers };
    expect(call.url).toBe("https://hub.example/api/workflow-skills/list");
    expect(call.headers.get("authorization")).toBe("Bearer sidecar-token");
    expect(call.headers.get("x-workflow-run-address")).toBe("run@runs.example");
  });

  test("throws on a non-OK response instead of reading as an empty registry", async () => {
    expect(
      listSkills({
        ...CONFIG,
        fetchImpl: async () => jsonResponse({ error: "nope" }, 503),
      }),
    ).rejects.toThrow(/Skill list failed: 503/);
  });

  test("throws when the response shape does not match", async () => {
    expect(
      listSkills({
        ...CONFIG,
        fetchImpl: async () => jsonResponse({ data: [{ name: "triage" }] }),
      }),
    ).rejects.toThrow(/did not match the expected shape/);
  });

  test("throws when the transport itself fails", async () => {
    expect(
      listSkills({
        ...CONFIG,
        fetchImpl: async () => {
          throw new Error("connection refused");
        },
      }),
    ).rejects.toThrow("connection refused");
  });

  test("refuses to call at all with no sidecar token", async () => {
    expect(
      listSkills({
        ...CONFIG,
        sidecarToken: "",
        fetchImpl: async () => jsonResponse({ data: [] }),
      }),
    ).rejects.toThrow(/no sidecar token/);
  });

  test("refuses to call at all with no run address", async () => {
    expect(
      listSkills({
        ...CONFIG,
        runAddress: "",
        fetchImpl: async () => jsonResponse({ data: [] }),
      }),
    ).rejects.toThrow(/no run address/);
  });
});

describe("searchSkills", () => {
  test("posts the query and returns the index", async () => {
    let body = "";
    const skills = await searchSkills(
      {
        ...CONFIG,
        fetchImpl: async (_input, init) => {
          body = String(init?.body);
          return jsonResponse({
            data: [{ name: "triage", description: "Sorts issues." }],
          });
        },
      },
      "issues",
    );
    expect(JSON.parse(body)).toEqual({ query: "issues" });
    expect(skills).toHaveLength(1);
  });

  test("throws on a 401 rather than returning nothing", async () => {
    expect(
      searchSkills(
        { ...CONFIG, fetchImpl: async () => jsonResponse({}, 401) },
        "issues",
      ),
    ).rejects.toThrow(/Skill search failed: 401/);
  });
});

describe("loadSkill", () => {
  test("returns the skill body", async () => {
    const skill = await loadSkill(
      {
        ...CONFIG,
        fetchImpl: async () =>
          jsonResponse({
            data: {
              name: "triage",
              description: "Sorts issues.",
              body: "Pick one label.",
            },
          }),
      },
      "triage",
    );
    expect(skill.body).toBe("Pick one label.");
  });

  test("throws when the skill is not visible to the run", async () => {
    expect(
      loadSkill(
        { ...CONFIG, fetchImpl: async () => jsonResponse({}, 404) },
        "triage",
      ),
    ).rejects.toThrow(/Skill load failed: 404/);
  });
});
