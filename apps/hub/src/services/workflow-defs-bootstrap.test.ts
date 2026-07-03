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

// Capture structured logs so a "published nowhere" warning can be asserted.
const warnLogs: { msg: string; meta?: unknown }[] = [];
mock.module("@intx/log", () => ({
  getLogger: () => ({
    info: () => {},
    warn: (msg: string, meta?: unknown) => warnLogs.push({ msg, meta }),
    error: () => {},
  }),
}));

// Tenant hierarchy fixture: slug → { id, ancestors }. getAncestorChain is
// mocked to return the recorded chain; findFirst resolves slug → id. Unknown
// slugs resolve to no tenant.
const TENANTS: Record<string, { id: string; ancestors: string[] }> = {
  "global-slug": { id: "ten_global", ancestors: ["ten_global"] },
  "abk-labs": { id: "ten_abk", ancestors: ["ten_abk", "ten_global"] },
  "second-tenant": {
    id: "ten_second",
    ancestors: ["ten_second", "ten_global"],
  },
  orphan: { id: "ten_orphan", ancestors: ["ten_orphan"] },
};
mock.module("@intx/db", () => ({
  schema: { tenant: { slug: "tenant.slug", id: "tenant.id" } },
  getAncestorChain: (_db: unknown, tenantId: string) => {
    const found = Object.values(TENANTS).find((t) => t.id === tenantId);
    return Promise.resolve(found?.ancestors ?? []);
  },
}));
mock.module("../db/schema", () => ({
  workflowRun: {
    kind: "wf.kind",
    tenantId: "wf.tenantId",
    deletedAt: "wf.deletedAt",
  },
}));
// Column-tagged predicate builders so the fake db.query below can read back the
// column + value it was asked to filter on.
mock.module("drizzle-orm", () => ({
  eq: (col: string, value: string) => ({ op: "eq", col, value }),
  and: (...conds: unknown[]) => ({ op: "and", conds }),
  isNull: (col: string) => ({ op: "isNull", col }),
}));

// Active (non-deleted) deployment index rows, keyed `${kind}:${tenantId}`. A
// test seeds this to assert per-(kind,tenant) idempotency.
let activeDeployments: Set<string>;
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

interface EqPred {
  op: "eq";
  col: string;
  value: string;
}
interface AndPred {
  op: "and";
  conds: { op: string; col: string; value?: string }[];
}
const coreDeps = {
  rootTenantId: "ten_global",
  db: {
    query: {
      tenant: {
        findFirst: ({ where }: { where: EqPred }) => {
          const t = TENANTS[where.value];
          return Promise.resolve(t ? { id: t.id } : undefined);
        },
      },
      workflowRun: {
        findFirst: ({ where }: { where: AndPred }) => {
          const kind = where.conds.find((c) => c.col === "wf.kind")?.value;
          const tenantId = where.conds.find(
            (c) => c.col === "wf.tenantId",
          )?.value;
          const active = activeDeployments.has(`${kind}:${tenantId}`);
          return Promise.resolve(active ? { id: "wfr_1" } : undefined);
        },
      },
    },
  },
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
  activeDeployments = new Set();
  warnLogs.length = 0;
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

  it("skips a def whose fingerprint matches AND the tenant already deploys it (idempotent)", async () => {
    // k1: fingerprint matches and ten_global already has an active deployment →
    // skipped. k2: fingerprint does not match → published.
    publishedDef = (kind) => (kind === "k1" ? realDef.definition : null);
    activeDeployments.add("k1:ten_global");
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
    });
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(
      (publishSpy.mock.calls[0]![1] as { targetTenantId: string })
        .targetTenantId,
    ).toBe("ten_global");
  });

  it("republishes a fingerprint-matching def to a tenant with no active deployment", async () => {
    // Fingerprint matches for both, but no tenant has an active deployment row →
    // both must still publish (this is the newly-seeded-tenant case).
    publishedDef = () => realDef.definition;
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
    });
    expect(publishSpy).toHaveBeenCalledTimes(2);
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

  it("routes a mapped kind to its descendant tenant, resolving the slug to its id", async () => {
    publishedDef = () => null;
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
      autopublishMap: { k1: ["abk-labs"], default: ["global-slug"] },
    });
    const targets = publishSpy.mock.calls.map(
      (c) => (c[1] as { targetTenantId: string }).targetTenantId,
    );
    // k1 → abk-labs (ten_abk); k2 → default → global-slug (ten_global).
    expect(targets.sort()).toEqual(["ten_abk", "ten_global"]);
  });

  it("falls back to the default map entry for a kind not explicitly mapped", async () => {
    publishedDef = () => null;
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
      autopublishMap: { default: ["abk-labs"] },
    });
    const targets = publishSpy.mock.calls.map(
      (c) => (c[1] as { targetTenantId: string }).targetTenantId,
    );
    expect(targets).toEqual(["ten_abk", "ten_abk"]);
  });

  it("falls back to the root tenant when neither the kind nor a default is mapped", async () => {
    publishedDef = () => null;
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
      autopublishMap: { "other-kind": ["abk-labs"] },
    });
    const targets = publishSpy.mock.calls.map(
      (c) => (c[1] as { targetTenantId: string }).targetTenantId,
    );
    expect(targets).toEqual(["ten_global", "ten_global"]);
  });

  it("publishes a kind mapped to two tenants into both", async () => {
    publishedDef = () => null;
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
      autopublishMap: { k1: ["abk-labs", "second-tenant"], default: [] },
    });
    const k1Targets = publishSpy.mock.calls
      .map((c) => (c[1] as { targetTenantId: string }).targetTenantId)
      .filter((t) => t === "ten_abk" || t === "ten_second");
    expect(k1Targets.sort()).toEqual(["ten_abk", "ten_second"]);
  });

  it("skips an unknown slug but still publishes the resolvable targets", async () => {
    publishedDef = () => null;
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
      autopublishMap: { k1: ["does-not-exist", "abk-labs"], default: [] },
    });
    const targets = publishSpy.mock.calls.map(
      (c) => (c[1] as { targetTenantId: string }).targetTenantId,
    );
    // Only the resolvable slug published; the unknown one is skipped.
    expect(targets).toEqual(["ten_abk"]);
  });

  it("skips a target whose tenant is not a descendant of the root tenant", async () => {
    publishedDef = () => null;
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
      autopublishMap: { k1: ["orphan", "abk-labs"], default: [] },
    });
    const targets = publishSpy.mock.calls.map(
      (c) => (c[1] as { targetTenantId: string }).targetTenantId,
    );
    expect(targets).toEqual(["ten_abk"]);
  });

  it("still publishes to a newly-mapped tenant when the per-kind fingerprint already matches", async () => {
    // The regression guard: k1's fingerprint matches AND ten_abk already has an
    // active deployment, but ten_second (newly added to the map) does not. A
    // per-kind-only idempotency check would skip BOTH and starve ten_second.
    publishedDef = () => realDef.definition;
    activeDeployments.add("k1:ten_abk");
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
      autopublishMap: { k1: ["abk-labs", "second-tenant"], default: [] },
    });
    const targets = publishSpy.mock.calls.map(
      (c) => (c[1] as { targetTenantId: string }).targetTenantId,
    );
    // ten_abk skipped (already has it), ten_second published (does not yet).
    expect(targets).toEqual(["ten_second"]);
  });

  it("de-dups a kind's target list so a repeated slug is not published twice", async () => {
    publishedDef = () => null;
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
      autopublishMap: { k1: ["abk-labs", "abk-labs"], default: [] },
    });
    const targets = publishSpy.mock.calls.map(
      (c) => (c[1] as { targetTenantId: string }).targetTenantId,
    );
    expect(targets).toEqual(["ten_abk"]);
  });

  it("warns and publishes nowhere when a kind's whole target list is unknown slugs", async () => {
    publishedDef = () => null;
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
      autopublishMap: { k1: ["nope", "also-nope"], default: [] },
    });
    // k1 resolves to zero valid tenants; k2 → default [] → zero. Neither publishes.
    expect(publishSpy).toHaveBeenCalledTimes(0);
    const nowhere = warnLogs.filter((l) =>
      l.msg.includes("resolved to no target tenant"),
    );
    expect(
      nowhere.map((l) => (l.meta as { kind: string }).kind).sort(),
    ).toEqual(["k1", "k2"]);
  });

  it("warns for an unmapped kind when default is an empty array (set-but-empty ≠ unset)", async () => {
    publishedDef = () => null;
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
      autopublishMap: { k1: ["abk-labs"], default: [] },
    });
    // k1 → abk-labs; k2 → default [] → nowhere + warned.
    const targets = publishSpy.mock.calls.map(
      (c) => (c[1] as { targetTenantId: string }).targetTenantId,
    );
    expect(targets).toEqual(["ten_abk"]);
    const nowhere = warnLogs.filter(
      (l) =>
        l.msg.includes("resolved to no target tenant") &&
        (l.meta as { kind: string }).kind === "k2",
    );
    expect(nowhere).toHaveLength(1);
  });

  it("waits for a sidecar connection before publishing (CL-2699)", async () => {
    publishedDef = () => null;
    // Probe reports no sidecar for the first 3 polls, then connected.
    let polls = 0;
    const isSidecarConnected = () => {
      polls += 1;
      return polls > 3;
    };
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
      isSidecarConnected,
      sidecarPollIntervalMs: 5,
      sidecarWaitTimeoutMs: 1_000,
    });
    // It polled through the disconnected window instead of publishing into it.
    expect(polls).toBeGreaterThan(3);
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });

  it("proceeds (fail-safe) when no sidecar connects within the bounded wait", async () => {
    publishedDef = () => null;
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
      isSidecarConnected: () => false,
      sidecarPollIntervalMs: 5,
      sidecarWaitTimeoutMs: 25,
    });
    // Still attempts every publish — a missing sidecar must never wedge boot.
    expect(publishSpy).toHaveBeenCalledTimes(2);
    const timedOut = warnLogs.filter((l) =>
      l.msg.includes("no sidecar connected"),
    );
    expect(timedOut).toHaveLength(1);
  });

  it("skips the wait entirely when the sidecar is already connected", async () => {
    publishedDef = () => null;
    let polls = 0;
    await publishEmbeddedWorkflowDefs({
      coreDeps,
      repoStore,
      enabled: true,
      buildSha: "abc",
      defsDir: fixtureDir,
      isSidecarConnected: () => {
        polls += 1;
        return true;
      },
      sidecarPollIntervalMs: 5,
      sidecarWaitTimeoutMs: 1_000,
    });
    expect(polls).toBe(1);
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });
});
