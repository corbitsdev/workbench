// Originating workbench for the warm agent's durable conversation.
//
// Chat mail names the room it speaks for in the RFC 2822 From local-part
// (`fromWorkbenchId`). The supervisor records that id when inbound mail
// arrives; the workflow-process child reads it before each send and binds
// the agent's durable conversation to `agent-state/<agentKey>/<workbenchId>/`.
// Missing or unparseable From is `_unscoped` so a later room never inherits
// a mixed blob.

import fs from "node:fs";
import path from "node:path";

import { type } from "arktype";
import { extractAddrSpec, parseHeaderSection } from "@intx/mime";

import { writeFileAtomicDurable } from "./atomic-write";
import { isErrnoNotFound } from "./conversation-state";

export const UNSCOPED_ORIGINATING_WORKBENCH_ID = "_unscoped";

const OriginRecord = type({
  fromWorkbenchId: "string",
});

function originRecordPath(dataDir: string, mailboxAddress: string): string {
  return path.join(
    dataDir,
    "inbound-origin",
    `${encodeURIComponent(mailboxAddress)}.json`,
  );
}

/**
 * Local-part of the inbound MIME From header. Chat encodes the originating
 * workbench id there; anything else (no From, unparseable) is undefined.
 */
export function extractOriginatingWorkbenchId(
  raw: Uint8Array,
): string | undefined {
  try {
    const { headers } = parseHeaderSection(raw);
    const from = headers.get("from");
    if (from === undefined || from.trim() === "") return undefined;
    const spec = extractAddrSpec(from);
    const at = spec.lastIndexOf("@");
    if (at <= 0) return undefined;
    const local = spec.slice(0, at);
    return local.length > 0 ? local : undefined;
  } catch {
    return undefined;
  }
}

export function resolveOriginatingWorkbenchId(
  fromWorkbenchId: string | undefined,
): string {
  return fromWorkbenchId !== undefined && fromWorkbenchId.length > 0
    ? fromWorkbenchId
    : UNSCOPED_ORIGINATING_WORKBENCH_ID;
}

/**
 * Persist the originating workbench id from inbound mail so the child can
 * bind conversation state before send. Never throws: a parse failure records
 * the unscoped sentinel rather than leaving a stale room id on disk.
 */
export async function recordOriginatingWorkbench(args: {
  dataDir: string;
  mailboxAddress: string;
  raw: Uint8Array;
}): Promise<void> {
  const fromWorkbenchId = resolveOriginatingWorkbenchId(
    extractOriginatingWorkbenchId(args.raw),
  );
  const target = originRecordPath(args.dataDir, args.mailboxAddress);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomicDurable(
    target,
    JSON.stringify({ fromWorkbenchId }),
    { mode: 0o600 },
  );
}

export async function readOriginatingWorkbenchId(args: {
  dataDir: string;
  mailboxAddress: string;
}): Promise<string> {
  const target = originRecordPath(args.dataDir, args.mailboxAddress);
  let raw: string;
  try {
    raw = await fs.promises.readFile(target, "utf8");
  } catch (cause) {
    if (isErrnoNotFound(cause)) return UNSCOPED_ORIGINATING_WORKBENCH_ID;
    throw cause;
  }
  const parsed: unknown = JSON.parse(raw);
  const validated = OriginRecord(parsed);
  if (validated instanceof type.errors || validated.fromWorkbenchId.length === 0) {
    return UNSCOPED_ORIGINATING_WORKBENCH_ID;
  }
  return validated.fromWorkbenchId;
}
