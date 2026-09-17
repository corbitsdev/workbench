// evidence kept as a regression proof: exercises the browser's exact
// GitHub connect→disconnect round-trip (`connections/github/complete` →
// credentials list → `connections/github/disconnect` → credentials list)
// against a booted hub on a scratch database with the operator's real `gh`
// token, proving the native connections routes the workbench-scoped mount was
// repointed to still round-trip. The token is read once from `gh auth token`
// at module load, never logged, never stored; the suite skips cleanly when no
// database URL is set or no gh auth is available (e.g. CI without a token).
import { describe, expect, test } from "bun:test";

import { resetSchema, setupDatabase } from "../scripts/db-setup.ts";
import {
  api,
  createCleanupHarness,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  hop,
  startHub,
  type HubHandle,
} from "./harness.ts";

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn("t3-proof: DATABASE_URL is not set; suite skipped.");
}

const { tempDir, track } = createCleanupHarness();

function readGhAuthToken(): string | undefined {
  try {
    const out = Bun.spawnSync(["gh", "auth", "token"]);
    if (out.exitCode !== 0) return undefined;
    const text = new TextDecoder().decode(out.stdout).trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

const ghToken = readGhAuthToken();
if (databaseUrl !== undefined && ghToken === undefined) {
  console.warn("t3-proof: `gh auth token` is unavailable; suite skipped.");
}

describe.skipIf(databaseUrl === undefined || ghToken === undefined)(
  "t3-proof: github connect-disconnect round-trip",
  () => {
    test("complete -> status -> disconnect -> status with a real token", async () => {
      const url = databaseUrl;
      if (url === undefined) throw new Error("unreachable: suite is skipped");

      await hop("database setup", async () => {
        await resetSchema(url);
        const report = await setupDatabase(url);
        expect(report.action).toBe("migrated");
      });

      const hub: HubHandle = await hop("hub boot", async () =>
        startHub({
          databaseUrl: url,
          port: freePort(),
          sessionSecret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"),
          dataDir: await tempDir("e2e-t3-proof-hub-data-"),
        }),
      );
      track(hub);

      const signup = await hop("genesis sign-up", async () => {
        const res = await api(hub.baseUrl, "POST", "/api/auth/sign-up/email", {
          name: "T3 Proof",
          email: "t3-proof@example.com",
          password: "password123",
        });
        expectStatus("sign-up", res, 200);
        if (res.cookies.length === 0) {
          throw new Error("sign-up returned no session cookie");
        }
        return res.cookies;
      });

      const tenantId = await hop("tenant create", async () => {
        const minted = await api(
          hub.baseUrl,
          "POST",
          "/api/tenants",
          { slug: "t3proof", name: "T3 Proof" },
          signup,
        );
        expectStatus("create tenant", minted, 201);
        const body = minted.data as { id?: string; tenantId?: string };
        const id =
          typeof body.id === "string"
            ? body.id
            : typeof body.tenantId === "string"
              ? body.tenantId
              : undefined;
        if (id === undefined) {
          throw new Error(`create tenant answered no id: ${JSON.stringify(minted.data)}`);
        }
        return id;
      });

      const token = await hop("read operator gh token", async () => {
        if (ghToken === undefined) {
          throw new Error("unreachable: suite is skipped");
        }
        console.log("token -> present (value never printed)");
        return ghToken;
      });

      const completePath = `/api/tenants/${tenantId}/connections/github/complete`;
      const disconnectPath = `/api/tenants/${tenantId}/connections/github/disconnect`;
      const credentialsPath = `/api/tenants/${tenantId}/credentials`;

      async function credentialPresent(what: string, credentialId: string): Promise<boolean> {
        const res = await api(hub.baseUrl, "GET", credentialsPath, undefined, signup);
        expectStatus(`credentials list (${what})`, res, 200);
        const rows = (res.data as { data: { id: string }[] }).data;
        console.log(
          `credentials (${what}) -> ${res.status} count=${rows.length} present=${rows.some((row) => row.id === credentialId)}`,
        );
        return rows.some((row) => row.id === credentialId);
      }

      const credentialId = await hop("connect (POST complete)", async () => {
        const res = await api(hub.baseUrl, "POST", completePath, { apiKey: token }, signup);
        expectStatus("github complete", res, 200);
        const body = res.data as { credentialId?: string; status?: string };
        console.log(
          `complete -> ${res.status} status=${body.status} credentialId=${body.credentialId}`,
        );
        if (body.credentialId === undefined || body.status !== "active") {
          throw new Error(`complete answered no active credential: ${JSON.stringify(res.data)}`);
        }
        return body.credentialId;
      });

      await hop("status reads connected", async () => {
        expect(await credentialPresent("after connect", credentialId)).toBe(true);
      });

      await hop("disconnect (DELETE)", async () => {
        const res = await api(hub.baseUrl, "DELETE", disconnectPath, undefined, signup);
        expectStatus("github disconnect", res, 204);
        console.log(`disconnect -> ${res.status}`);
      });

      await hop("status reads disconnected", async () => {
        expect(await credentialPresent("after disconnect", credentialId)).toBe(false);
      });
    }, 180_000);
  },
);
