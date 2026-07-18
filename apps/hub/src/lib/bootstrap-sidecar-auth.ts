import { sha256 } from "@intx/crypto";
import { sidecar } from "@intx/db/schema";
import { getLogger } from "@intx/log";

import type { HubDb } from "../db";

const log = getLogger(["api", "sidecar-auth"]);

export type SidecarAuthBootstrap = {
  id: string;
  token: string;
  url: string;
};

/**
 * Idempotently upsert the deployment's `sidecar` row so the WS token
 * authenticator (`createSidecarTokenAuthenticator`) can admit the sidecar's
 * handshake. Interchange migration 0036 added `token_hash_sha256` (NOT NULL,
 * unique) and deleted the old REST self-registration route; nothing else in the
 * hub or upstream writes the column, so without this boot step no sidecar can
 * complete the handshake after the runtime-retirement bump.
 *
 * The row is keyed on the deployment's single shared SIDECAR_ID and stores
 * `token_hash_sha256 = sha256(SIDECAR_TOKEN)`. The authenticator hashes the
 * plaintext token the sidecar presents and looks the row up by digest; a match
 * yields the row id as the verified sidecar identity. Keeping the row id equal
 * to the sidecar process's SIDECAR_ID keeps the verified id in agreement with
 * the frame's claimed id (otherwise the handshake still succeeds but logs a
 * mismatch warning on every reconnect).
 */
export async function bootstrapSidecarAuth(
  db: HubDb,
  input: SidecarAuthBootstrap,
): Promise<void> {
  const tokenHash = await sha256(input.token);
  const now = new Date();
  await db
    .insert(sidecar)
    .values({
      id: input.id,
      url: input.url,
      tokenHashSha256: tokenHash,
      status: "online",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: sidecar.id,
      set: {
        url: input.url,
        tokenHashSha256: tokenHash,
        updatedAt: now,
      },
    });
  log.info("Sidecar auth row bootstrapped", { sidecarId: input.id });
}
