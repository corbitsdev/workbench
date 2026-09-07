#!/usr/bin/env bun
// Backfill per-principal signing keys onto principals that predate the
// per-principal-key feature (upstream's bin/backfill-principal-keys.ts,
// adapted to workbench's DATABASE_URL plumbing).
//
// Run ONCE as the last step of the deploy that introduces per-principal
// keys, AFTER the key-minting hub is live. It is safe against a live hub:
// nothing reads principal keys yet, the hub only mints for newly-created
// principals, and the active-key unique index blocks a double key.
// Idempotent — a principal that already holds an active key is skipped —
// so it is safe to re-run or resume after a partial failure. On a database
// where every principal was created after the feature landed (e.g. local
// dev), it does nothing.
//
//   set -a; . .env; set +a
//   bun run scripts/backfill-principal-keys.ts
//
// It reads the same DATABASE_URL and PRINCIPAL_KEY_ENCRYPTION_KEY the hub
// uses. The key is required: the seeds must be sealed under the same cipher
// the hub decrypts with, so there is no noop fallback.

import {
  backfillPrincipalKeys,
  createDB,
  createPrincipalKeyStore,
} from "@intx/db";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { getLogger, setup } from "@intx/log";

await setup({ dev: true });
const log = getLogger(["backfill-principal-keys"]);

const keyHex = process.env["PRINCIPAL_KEY_ENCRYPTION_KEY"];
if (keyHex === undefined || keyHex.trim() === "") {
  throw new Error(
    "PRINCIPAL_KEY_ENCRYPTION_KEY environment variable is required",
  );
}
const cipher = createEnvKeyCredentialCipher(Buffer.from(keyHex, "hex"));

const databaseUrl = process.env["DATABASE_URL"];
if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL environment variable is required");
}
const url = new URL(databaseUrl);
const { db, close } = createDB({
  host: url.hostname,
  port: url.port === "" ? 5432 : Number(url.port),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ""),
});
try {
  const store = createPrincipalKeyStore({ db, cipher });
  const report = await backfillPrincipalKeys(db, store);
  log.info(
    "Backfill complete: minted {keysGenerated} new signing key(s); " +
      "{alreadyKeyed} principal(s) already keyed.",
    report,
  );
} finally {
  await close();
}
