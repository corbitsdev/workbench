import { and, eq, inArray } from "drizzle-orm";
import { schema as intxSchema, getAncestorChain } from "@intx/db";
import {
  createAgent,
  createDefaultDirectorRegistry,
  defineAgent,
  type AuthorizeFn,
} from "@intx/agent";
import { createInboundMessage } from "@intx/mime";
import type { MessageAttachment } from "@intx/types/runtime";
import { parseInferenceEvent } from "@intx/types/runtime";
import type { AnalyticsSubscriber } from "@workbench/analytics";
import { type } from "arktype";
import { createIsogitStore } from "@workbench/storage-isogit";
import { FILE_PARSER_NAME, FILE_PARSER_SYSTEM_PROMPT } from "@workbench/agents";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import { getConfig } from "../config";
import { resolveInstanceSourcesFromDefinition } from "./agent-provisioning";

const log = getLogger(["api", "file-parser"]);

const { agent } = intxSchema;

const ALLOW_ALL_AUTHORIZE: AuthorizeFn = async () => ({
  effect: "allow" as const,
  matchingGrants: [],
  resolvedBy: null,
});

const logTeardownError = (op: string) => (err: unknown) =>
  log.warn(`File parse turn teardown failed: ${op}`, {
    error: err instanceof Error ? err.message : String(err),
  });

/**
 * Raised when a document could not be parsed — no File Parser definition seeded,
 * no resolvable Anthropic inference source, or the parse turn produced no text.
 * The caller (the `parse_file` tool handler) surfaces the message to the agent
 * as a tool error rather than swallowing it.
 */
export class FileParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FileParseError";
  }
}

/**
 * Resolve the File Parser agent definition by walking the tenant hierarchy —
 * the definition is seeded once in the org tenant (deployable: false) and shared
 * by all descendants, so we accept the most specific one in the ancestor chain.
 */
async function resolveFileParserDefinition(
  db: HubDb,
  tenantId: string,
): Promise<typeof agent.$inferSelect | null> {
  const chain = await getAncestorChain(db as never, tenantId);
  const defs = await db.query.agent.findMany({
    where: and(
      inArray(agent.tenantId, chain),
      eq(agent.name, FILE_PARSER_NAME),
    ),
  });
  if (defs.length === 0) return null;

  let best = defs[0]!;
  let bestIdx = chain.indexOf(best.tenantId);
  for (const candidate of defs) {
    const idx = chain.indexOf(candidate.tenantId);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      best = candidate;
      bestIdx = idx;
    }
  }
  return best;
}

export interface ParseDocumentInput {
  tenantId: string;
  /**
   * Stable id the parse's durable audit tree is keyed by — the file artifact id.
   * Keeps each parse's on-disk trace traceable back to the exact artifact and
   * gives concurrent parses distinct working trees (see `parseDocument`).
   */
  traceId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  /** Optional extraction directive from the agent (e.g. "list every action item"). */
  instructions?: string;
}

/**
 * Parse a single document/image by running one non-streaming @intx/agent turn on
 * the Anthropic-bound File Parser definition, sending the raw bytes as a
 * `MessageAttachment`. The anthropic adapter marshals the bytes into a native
 * document content block (`turns.ts` → `anthropic.ts`), so a doc-incapable
 * caller (Myra on kimi) gets faithful text back regardless of its own model.
 */
/**
 * Attribution + sink for the file-parse turn's inference usage (CL-2801). The
 * parse runs an in-process one-shot agent that never emits a sidecar
 * `agent.event`, so its tokens are invisible to Insights unless we forward the
 * local stream into the analytics subscriber. Usage is attributed to the
 * caller (the agent that invoked `parse_file`), whose synthetic principal is
 * `attributionPrincipalId`.
 */
export interface ParseDocumentAnalytics {
  analytics: AnalyticsSubscriber;
  attributionPrincipalId: string;
}

export async function parseDocument(
  db: HubDb,
  input: ParseDocumentInput,
  analytics?: ParseDocumentAnalytics,
): Promise<string> {
  const def = await resolveFileParserDefinition(db, input.tenantId);
  if (!def) {
    throw new FileParseError(
      "No File Parser agent is configured for this tenant (seed the 'File Parser' definition and an anthropic-api credential).",
    );
  }

  const resolution = await resolveInstanceSourcesFromDefinition(
    db,
    input.tenantId,
    def,
    null,
  );
  if (!resolution.ok) {
    throw new FileParseError(
      `Could not resolve an inference source for the File Parser: ${resolution.reason}`,
    );
  }
  const [source] = resolution.sources;
  if (!source) {
    throw new FileParseError(
      "File Parser resolved no inference source (missing Anthropic model offering).",
    );
  }

  // An ephemeral one-shot agent (no resident session) backed by a durable,
  // fully git-backed isogit store — the store IS the audit trail, so it is kept,
  // not deleted. Keyed per (tenant, artifact) so every parse's trace is
  // traceable back to the exact file AND concurrent parses of different files
  // get distinct working trees: @intx/agent holds a singleton-per-workdir lock,
  // so a shared dir would serialize/deadlock the parses a multi-file upload
  // fires at once.
  const contextDir = join(
    getConfig().hub.dataDir,
    "file-parser",
    input.tenantId,
    input.traceId,
  );
  // No GC policy: each repo receives exactly one parse turn (keyed per
  // traceId), so per-repo growth is bounded and a write-path reclaim
  // threshold could never be reached.
  const store = await createIsogitStore(contextDir);

  const def_ = defineAgent({
    id: `file-parser-${randomUUID()}`,
    systemPrompt: FILE_PARSER_SYSTEM_PROMPT,
    tools: [],
    capabilities: [],
    inference: {
      sources: [{ provider: source.provider, model: source.model }],
    },
  });

  const env = {
    sources: [source],
    defaultSource: source.id,
    storage: store,
    workdir: contextDir,
    audit: store,
    authorize: ALLOW_ALL_AUTHORIZE,
    directors: createDefaultDirectorRegistry(),
    closeTimeoutMs: 1000,
  };

  const attachment: MessageAttachment = {
    name: input.filename,
    contentType: input.mimeType,
    data: input.bytes,
  };
  const prompt =
    input.instructions && input.instructions.trim() !== ""
      ? input.instructions.trim()
      : "Transcribe the attached document as faithful, well-structured Markdown.";
  const message = createInboundMessage({
    from: "user@local",
    to: "agent@local",
    content: prompt,
    interchangeType: "conversation.message",
    attachments: [attachment],
  });

  const agentInst = await createAgent(def_, env);

  // Drain the event stream so the reactor never backs up on an unread channel;
  // the extracted text comes from the send() reply, not the stream. The parse
  // turn is NOT recorded to any session — attributing it to the caller's live
  // session persisted the document dump as a phantom assistant turn (CL-2628
  // review). Token usage IS forwarded (CL-2801): each inference event is fed to
  // the analytics subscriber, keyed by this one-shot's own agent id so its seq
  // space can't collide with the caller's sidecar events, and attributed to the
  // caller's instance so its cost rolls up to the right person.
  async function drainStream(): Promise<void> {
    for await (const event of agentInst.stream()) {
      if (analytics === undefined) continue;
      const validated = parseInferenceEvent(event);
      if (validated instanceof type.errors) continue;
      await analytics.analytics.onLocalInferenceEvent({
        tenantId: input.tenantId,
        attributionPrincipalId: analytics.attributionPrincipalId,
        eventAddress: def_.id,
        event: validated,
      });
    }
  }
  const pumpDone = drainStream();

  try {
    const result = await agentInst.send(message);
    const text = result.reply;
    if (!text || text.trim() === "") {
      throw new FileParseError("The File Parser returned no content.");
    }
    return text;
  } finally {
    // The isogit store (contextDir) is deliberately NOT removed — it is the
    // durable, auditable trace of the parse turn.
    await agentInst.close().catch(logTeardownError("close agent"));
    await pumpDone.catch(logTeardownError("pump stream"));
  }
}
