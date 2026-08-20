// Vendored from gtm-workbench's `packages/workflow-host/src/adapters/
// effect-ledger.ts` (gtm-origin, not upstream Interchange -- see
// VENDORED.md and docs/revendor-inventory.md). Copied verbatim apart
// from the import path below (`@workbench/hub-sessions/substrate` ->
// `@intx/hub-sessions/substrate`, this repo's package name for the same
// module).
//
// Production `WorkflowRuntimeEnv.EffectLedger` adapter.
//
// Crash-safe exactly-once substrate for action effects. Distinct from the
// run event log: each `record` commits through `writeTreePreservingPrefix`
// under `runs/<runId>/blobs/`, so a dropped run-log buffer never takes the
// ledger with it. The workflow-run kind handler already permits the blobs/
// subtree and enforces append-only immutability for those paths -- reusing
// that layout avoids an interchange pin bump while still satisfying the
// EffectLedger durability contract.
//
// Layout: `runs/<runId>/blobs/<sha256(effectKey)>` holds JSON
// `{ "output": <value> }`. The on-disk name is the SHA-256 of the identity
// effect key (not of the envelope bytes). That cohabits with content-
// addressed spill blobs under the same `blobs/` prefix: the kind handler
// only enforces 64-hex filenames + byte immutability, not
// `filename == sha256(bytes)`. Callers must not assume every entry under
// `blobs/` is pure content-addressed; GC or verify tooling that does will
// mis-handle ledger entries. A dedicated `effects/` subtree would need a
// kind-handler change (and an interchange pin bump).
//
// Outputs must JSON-serialize into a real `{output}` envelope. Values that
// `JSON.stringify` drops (`undefined`, functions, symbols) fail closed on
// `record` rather than writing a bare `{}` that later `lookup` would reject.

import { hexEncode } from "@intx/types";
import type {
  Principal,
  RepoId,
  RepoStore as SubstrateRepoStore,
} from "@intx/hub-sessions/substrate";
import type { EffectLedger } from "@intx/workflow";

import {
  isErrnoNotFound,
  readRunBlob,
  writeRunBlob,
  type RunBlobStoreOpts,
} from "./run-blobs";

export type WorkflowRunEffectLedgerOpts = {
  substrate: SubstrateRepoStore;
  repoId: RepoId;
  principal: Principal;
  /** Run id whose effect ledger this adapter owns. Fresh adapter per run. */
  runId: string;
  /** Workflow-run repo ref (typically `refs/heads/main`). */
  ref: string;
};

/**
 * Construct a durable `EffectLedger` for one run. Lookup/record go through
 * the workflow-run substrate under `runs/<runId>/blobs/`.
 */
export function createWorkflowRunEffectLedger(
  opts: WorkflowRunEffectLedgerOpts,
): EffectLedger {
  const store: RunBlobStoreOpts = opts;
  return {
    async lookup(effectKey) {
      const key = await identityKeyHex(effectKey);
      try {
        const bytes = await readRunBlob(store, key);
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          !("output" in parsed)
        ) {
          throw new Error(
            `workflow-runtime: effect ledger entry ${key} for run ${opts.runId} is not a {output} envelope`,
          );
        }
        return { output: (parsed as { output: unknown }).output };
      } catch (cause) {
        if (isErrnoNotFound(cause)) return undefined;
        throw cause;
      }
    },
    async record(effectKey, output) {
      const key = await identityKeyHex(effectKey);
      // JSON.stringify omits keys whose value is undefined and returns
      // undefined for bare undefined/function/symbol top-level values. Either
      // form would leave a non-{output} envelope on disk; fail closed before
      // the substrate write (mirrors blob-substrate's serialize guard).
      const encoded = JSON.stringify({ output });
      if (encoded === undefined || !hasOutputEnvelope(encoded)) {
        throw new Error(
          `workflow-runtime: effect ledger cannot serialize output for key ${key} on run ${opts.runId} (typeof ${typeof output})`,
        );
      }
      const bytes = new TextEncoder().encode(encoded);
      // Same-key re-record with identical bytes is accepted by the kind
      // handler's append-only compare; a divergent re-record fails closed.
      await writeRunBlob(
        store,
        key,
        bytes,
        `record effect ${key} for run ${opts.runId}`,
      );
    },
  };
}

function hasOutputEnvelope(encoded: string): boolean {
  const parsed: unknown = JSON.parse(encoded);
  return parsed !== null && typeof parsed === "object" && "output" in parsed;
}

async function identityKeyHex(effectKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ArrayBuffer-backed at the call site; Web Crypto's BufferSource type rejects Uint8Array<ArrayBufferLike> under TS 5.9
    new TextEncoder().encode(effectKey) as Uint8Array<ArrayBuffer>,
  );
  return hexEncode(new Uint8Array(digest));
}
