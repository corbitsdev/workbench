// Smoke scenario 4/5 (CL-6004): library. An artifact is uploaded
// through the multipart upload route, then read back both via the
// list route and by id. The hub wires uploads through
// `InlineContentStore` (`apps/hub/src/artifacts-mount.ts`): the bytes
// land in a separate `upload` table (bytea) and the artifact's own
// `content` field stays empty, with `source.upload` carrying the
// filename/mimeType/size reference — there is no download route
// mounted for this store today, so the round-trip this scenario proves
// is that reference surviving intact through upload, list, and
// get-by-id, not a `content` string equality. No inference, no
// credential, no external network call of any kind.

import { describe, expect, test } from "bun:test";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  api,
  createCleanupHarness,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  hop,
  startHub,
} from "./harness.ts";

const { tempDir, track } = createCleanupHarness();

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "smoke-library: DATABASE_URL is not set; suite skipped. Set " +
      "DATABASE_URL (see .env.example) to run it; start Postgres with `docker compose -f docker-compose.test.yml up -d` " +
      "so this skip can never pass silently there.",
  );
}

function stringField(data: unknown, field: string, what: string): string {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new Error(
    `${what}: missing string field "${field}": ${JSON.stringify(data)}`,
  );
}

type UploadReference = { filename: string; mimeType: string; size: number };

function uploadRef(data: unknown, what: string): UploadReference {
  if (
    typeof data === "object" &&
    data !== null &&
    "source" in data &&
    typeof (data as { source: unknown }).source === "object"
  ) {
    const source = (data as { source: Record<string, unknown> }).source;
    const upload = source["upload"];
    if (
      typeof upload === "object" &&
      upload !== null &&
      "filename" in upload &&
      "mimeType" in upload &&
      "size" in upload
    ) {
      return upload as UploadReference;
    }
  }
  throw new Error(
    `${what}: missing source.upload reference: ${JSON.stringify(data)}`,
  );
}

/**
 * Multipart upload bypasses `harness.ts`'s `api()` helper (which always
 * sends `application/json`) — `fetch` sets its own multipart boundary
 * header when given a `FormData` body, so it must not be overridden.
 * The mime type is deliberately not a `text/*` or `application/json`
 * type: Bun's own FormData serializer appends `;charset=utf-8` to
 * those, which the artifacts upload policy then refuses as an exact
 * mismatch — `application/pdf` (on the policy's allowlist) is not
 * affected and needs no real PDF structure for this byte-storage path.
 */
async function uploadArtifact(
  baseUrl: string,
  tenantId: string,
  cookies: string[],
  fileName: string,
  bytes: Uint8Array,
): Promise<{ status: number; data: unknown }> {
  const form = new FormData();
  form.append(
    "file",
    new File([Uint8Array.from(bytes)], fileName, { type: "application/pdf" }),
  );
  const res = await fetch(
    `${baseUrl}/api/tenants/${tenantId}/artifacts/upload`,
    {
      method: "POST",
      headers: { cookie: cookies.join("; ") },
      body: form,
    },
  );
  const data: unknown = await res.json();
  return { status: res.status, data };
}

describe.skipIf(databaseUrl === undefined)("smoke: library", () => {
  test("an uploaded artifact is listed and fetchable by id with its upload reference intact", async () => {
    const url = databaseUrl;
    if (url === undefined) throw new Error("unreachable: suite is skipped");

    await hop("database setup", async () => {
      await resetSchema(url);
      await setupDatabase(url);
    });

    const dataDir = await tempDir("e2e-smoke-library-hub-data-");
    const hub = await hop("hub boot", () =>
      startHub({
        databaseUrl: url,
        port: freePort(),
        sessionSecret: Buffer.from(
          crypto.getRandomValues(new Uint8Array(32)),
        ).toString("hex"),
        dataDir,
      }),
    );
    track(hub);
    const baseUrl = hub.baseUrl;

    const cookies = await hop("sign-up", async () => {
      const res = await api(baseUrl, "POST", "/api/auth/sign-up/email", {
        name: "Library Smoke Tester",
        email: `smoke-library-${crypto.randomUUID()}@example.invalid`,
        password: `pw-${crypto.randomUUID()}`,
      });
      expectStatus("sign-up", res, 200);
      if (res.cookies.length === 0) {
        throw new Error("sign-up returned no session cookie");
      }
      return res.cookies;
    });

    const tenantId = await hop("tenant creation", async () => {
      const slug = `smokelib${crypto.randomUUID().slice(0, 8)}`;
      const res = await api(
        baseUrl,
        "POST",
        "/api/tenants",
        { name: "Library Smoke", slug },
        cookies,
      );
      expectStatus("create tenant", res, 201);
      return stringField(res.data, "id", "create tenant");
    });

    const fileBytes = new TextEncoder().encode(
      `smoke library bytes ${crypto.randomUUID()}`,
    );
    const artifactId = await hop("upload an artifact", async () => {
      const res = await uploadArtifact(
        baseUrl,
        tenantId,
        cookies,
        "smoke.pdf",
        fileBytes,
      );
      if (res.status !== 201) {
        throw new Error(
          `upload artifact: expected HTTP 201, got ${res.status}: ${JSON.stringify(res.data)}`,
        );
      }
      const items = (res.data as { data: { id: string; title: string }[] })
        .data;
      if (items.length !== 1) {
        throw new Error(
          `upload artifact: expected exactly one item, got: ${JSON.stringify(res.data)}`,
        );
      }
      const item = items[0];
      expect(item?.title).toBe("smoke.pdf");
      const ref = uploadRef(item, "upload response");
      expect(ref.filename).toBe("smoke.pdf");
      expect(ref.mimeType).toBe("application/pdf");
      expect(ref.size).toBe(fileBytes.byteLength);
      return stringField({ id: item?.id }, "id", "upload artifact");
    });

    await hop("the artifact is listed", async () => {
      const res = await api(
        baseUrl,
        "GET",
        `/api/tenants/${tenantId}/artifacts`,
        undefined,
        cookies,
      );
      expectStatus("list artifacts", res, 200);
      const items = (res.data as { data: { id: string; title: string }[] })
        .data;
      const found = items.find((item) => item.id === artifactId);
      if (found === undefined) {
        throw new Error(
          `uploaded artifact missing from the listing: ${JSON.stringify(items)}`,
        );
      }
      expect(found.title).toBe("smoke.pdf");
    });

    await hop(
      "the artifact is fetchable by id with its upload reference intact",
      async () => {
        const res = await api(
          baseUrl,
          "GET",
          `/api/tenants/${tenantId}/artifacts/${artifactId}`,
          undefined,
          cookies,
        );
        expectStatus("get artifact", res, 200);
        const data = res.data as { id: string };
        expect(data.id).toBe(artifactId);
        const ref = uploadRef(data, "get artifact response");
        expect(ref.filename).toBe("smoke.pdf");
        expect(ref.mimeType).toBe("application/pdf");
        expect(ref.size).toBe(fileBytes.byteLength);
      },
    );
  }, 60_000);
});
