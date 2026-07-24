import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { sha256 } from "@intx/crypto";
import { hexEncode } from "@intx/types";
import { createSidecarTokenAuthenticator } from "@workbench/hub-sessions";

import { schema } from "../db";
import type { HubDb } from "../db";
import { bootstrapSidecarAuth } from "./bootstrap-sidecar-auth";

// Real-Postgres (PGlite) exercise of the boot bootstrap across the seam with
// the upstream WS token authenticator: prove that a fresh DB + boot seeding
// makes createSidecarTokenAuthenticator admit the sidecar's real token and
// reject anything else. Mocking either side would prove nothing about the
// integrated handshake.

const SIDECAR_ID = "gtm-sidecar-1";
const SIDECAR_URL = "sidecar://in-cluster";
const TOKEN = "the-real-sidecar-token";

let client: PGlite;
let db: HubDb;

beforeAll(async () => {
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  db = bootstrap as unknown as HubDb;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.exec(`DELETE FROM "sidecar";`);
});

describe("bootstrapSidecarAuth", () => {
  test("boot seeding lets the token authenticator accept the real token and reject a wrong one", async () => {
    await bootstrapSidecarAuth(db, {
      id: SIDECAR_ID,
      token: TOKEN,
      url: SIDECAR_URL,
    });

    const authenticate = createSidecarTokenAuthenticator({ db });

    const accepted = await authenticate({
      sidecarId: SIDECAR_ID,
      token: TOKEN,
    });
    expect(accepted).toEqual({ kind: "sidecar", sidecarId: SIDECAR_ID });

    const rejected = await authenticate({
      sidecarId: SIDECAR_ID,
      token: "not-the-token",
    });
    expect(rejected).toBeNull();
  });

  test("stores only the sha256 digest of the token, never the plaintext", async () => {
    await bootstrapSidecarAuth(db, {
      id: SIDECAR_ID,
      token: TOKEN,
      url: SIDECAR_URL,
    });

    const row = await db.query.sidecar.findFirst();
    expect(row?.id).toBe(SIDECAR_ID);
    expect(row?.url).toBe(SIDECAR_URL);
    expect(hexEncode(row!.tokenHashSha256)).toBe(
      hexEncode(await sha256(TOKEN)),
    );
  });

  test("is idempotent and re-keys the hash when the token rotates", async () => {
    await bootstrapSidecarAuth(db, {
      id: SIDECAR_ID,
      token: TOKEN,
      url: SIDECAR_URL,
    });
    await bootstrapSidecarAuth(db, {
      id: SIDECAR_ID,
      token: "rotated-token",
      url: SIDECAR_URL,
    });

    const rows = await db.query.sidecar.findMany();
    expect(rows).toHaveLength(1);

    const authenticate = createSidecarTokenAuthenticator({ db });
    expect(
      await authenticate({ sidecarId: SIDECAR_ID, token: "rotated-token" }),
    ).toEqual({ kind: "sidecar", sidecarId: SIDECAR_ID });
    expect(
      await authenticate({ sidecarId: SIDECAR_ID, token: TOKEN }),
    ).toBeNull();
  });
});
