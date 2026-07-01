import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embeddedWorkflowDefsDir } from "../lib/workflow-defs-embedded";

// Spy for the publish core; reset per test. `readWorkflowDefinition` is mocked
// to control the "currently-published" def the idempotency check compares to.
const publishSpy =
  mock<(...args: unknown[]) => Promise<{ deploymentId: string }>>();
let publishedDef: ((kind: string) => unknown) | null = null;

class FakeNoPrincipal extends Error {}
mock.module("../routes/workflow-deploy", () => ({
  publishWorkflowDefinition: publishSpy,
  NoDeployingPrincipalError: FakeNoPrincipal,
}));
mock.module("./workflow-deploy", () => ({
  readWorkflowDefinition: (_repoStore: unknown, kind: string) => {
    const def = publishedDef?.(kind);
    return def === undefined || def === null
      ? Promise.reject(new Error("not published"))
      : Promise.resolve(def);
  },
}));

const { publishEmbeddedWorkflowDefs } = await import(
  "./workflow-defs-bootstrap"
);

const coreDeps = {
  rootTenantId: "ten_global",
} as unknown as Parameters<typeof publishEmbeddedWorkflowDefs>[0]["coreDeps"];
const repoStore = {} as unknown as Parameters<
  typeof publishEmbeddedWorkflowDefs
>[0]["repoStore"];

let fixtureDir: string;
let realDef: { kind: string; version: string; definition: unknown };

beforeEach(async () => {
  publishSpy.mockReset();
  publishSpy.mockResolvedValue({ deploymentId: "ses_x" });
  publishedDef = null;
  // Clone a real committed def (guaranteed to satisfy the envelope schema) into
  // two fixtures with distinct kinds.
  realDef = JSON.parse(
    await readFile(join(embeddedWorkflowDefsDir(), "smoke-test.json"), "utf8"),
  );
  fixtureDir = await mkdtemp(join(tmpdir(), "wf-defs-"));
  for (const kind of ["k1", "k2"]) {
    await writeFile(
      join(fixtureDir, `${kind}.json`),
      JSON.stringify({ ...realDef, kind }),
    );
  }
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe("publishEmbeddedWorkflowDefs", () => {
  it("is a no-op when the flag is disabled", async () => {
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: false,
      buildSha: "abc",
      defsDir: fixtureDir,
    });
    expect(publishSpy).toHaveBeenCalledTimes(0);
  });

  it("publishes each embedded def to the global tenant when enabled", async () => {
    publishedDef = () => null; // nothing published yet
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc123",
      defsDir: fixtureDir,
    });
    expect(publishSpy).toHaveBeenCalledTimes(2);
    const call = publishSpy.mock.calls[0]!;
    expect((call[1] as { targetTenantId: string }).targetTenantId).toBe(
      "ten_global",
    );
    expect((call[1] as { deployMeta: { sha: string } }).deployMeta.sha).toBe(
      "abc123",
    );
  });

  it("skips a def whose published fingerprint already matches (idempotent)", async () => {
    // k1 is already published with the identical definition → skipped; k2 isn't.
    publishedDef = (kind) => (kind === "k1" ? realDef.definition : null);
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
    });
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it("isolates a per-def failure — the other defs still publish, no throw", async () => {
    publishedDef = () => null;
    publishSpy.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
    });
    // Both attempted; the first threw, the second still ran. Resolved without throwing.
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });

  it("treats a missing deploying principal as a graceful skip (no throw, others proceed)", async () => {
    publishedDef = () => null;
    publishSpy.mockImplementationOnce(() =>
      Promise.reject(new FakeNoPrincipal("no principal")),
    );
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
    });
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });
});
