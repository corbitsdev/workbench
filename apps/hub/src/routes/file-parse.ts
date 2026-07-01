import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute, resolver } from "hono-openapi";
import { and, eq } from "drizzle-orm";
import { type } from "arktype";
import { randomUUID } from "node:crypto";
import { getLogger } from "@intx/log";
import { isAllowedMimeType } from "@intx/types";
import { schema as intxSchema } from "@intx/db";
import type { HubDb } from "../db";
import { artifact, artifactVersion, memberAgentInstance } from "../db/schema";
import { parseDocument, FileParseError } from "../services/file-parser";
import { getRequestedUserContext } from "../lib/user-context";
import { requestBodySchema } from "../lib/openapi";

const log = getLogger(["api", "file-parse"]);

// This route owns its own ceilings — it must not borrow another feature's
// upload limit, or a change there would silently move this endpoint's cap.
const MAX_PARSE_FILE_BYTES = 10 * 1024 * 1024; // 10 MB decoded document ceiling.
// Base64 of the 10 MB per-file ceiling is ~13.3 MB; add JSON + field overhead.
const MAX_PARSE_BODY_BYTES = 15 * 1024 * 1024;
// A parse runs a doc-capable inference turn in-request; cap how long we hold the
// connection so a slow/hung upstream returns a clean 504 instead of hanging.
const PARSE_TIMEOUT_MS = 90_000;

class ParseTimeoutError extends Error {
  constructor() {
    super("The document took too long to parse.");
    this.name = "ParseTimeoutError";
  }
}

// Base64 with optional padding. Buffer.from silently drops invalid bytes, so we
// validate the shape at the boundary rather than store a corrupt artifact.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function isValidBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_RE.test(value);
}

async function withParseTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ParseTimeoutError()), PARSE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// A document a user uploaded to Myra. `data` is raw base64 (no data: prefix);
// the handler stores it as a `data:<mime>;base64,<data>` file artifact and runs
// it through the doc-capable File Parser so Myra receives extracted text even
// though her own adapter cannot consume document content blocks.
export const ParseFileRequestSchema = type({
  filename: "string > 0",
  mimeType: "string > 0",
  data: "string > 0",
});
export type ParseFileRequest = typeof ParseFileRequestSchema.infer;

export const ParseFileResponseSchema = type({
  artifactId: "string",
  filename: "string",
  parsedText: "string",
});
export type ParseFileResponse = typeof ParseFileResponseSchema.infer;

const ErrorResponse = type({ error: "string" });

/**
 * Divert a document away from the inline-mail path: store it as a file artifact
 * and return its extracted text so the client can fold that text into the
 * message it sends Myra. Documents must never ride inline to Myra — her
 * openai-compatible adapter throws on document content blocks — so this is the
 * upload path her composer routes documents through.
 */
export function createFileParseRouter(
  db: HubDb,
): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

  router.post(
    "/instances/:instanceId/parse-file",
    describeRoute({
      tags: ["Instances"],
      summary: "Upload a document to an agent and get its extracted text",
      description:
        "Stores a base64 document as a file artifact and parses it through the doc-capable File Parser. Returns the artifact id and extracted text so the caller can fold the text into the message sent to a document-incapable agent (e.g. Myra). Documents are never sent inline over mail.",
      parameters: [
        {
          name: "instanceId",
          in: "path",
          required: true,
          description: "Agent instance the document is being uploaded to.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: requestBodySchema(ParseFileRequestSchema),
          },
        },
      },
      responses: {
        201: {
          description: "Document stored and parsed",
          content: {
            "application/json": {
              schema: resolver(ParseFileResponseSchema),
            },
          },
        },
        400: {
          description: "Invalid request body",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        403: {
          description: "Instance not accessible",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Instance not found",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        413: {
          description: "Document exceeds the maximum allowed size",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        415: {
          description: "Unsupported document type",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        502: {
          description: "The document could not be parsed",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        504: {
          description: "The document took too long to parse",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    bodyLimit({
      maxSize: MAX_PARSE_BODY_BYTES,
      onError: (c) =>
        c.json({ error: "Document exceeds the maximum allowed size" }, 413),
    }),
    async (c) => {
      const userId = c.get("userId");
      const instanceId = c.req.param("instanceId");

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      const parsed = ParseFileRequestSchema(body);
      if (parsed instanceof type.errors) {
        return c.json({ error: parsed.summary }, 400);
      }

      const instance = await db.query.agentInstance.findFirst({
        where: eq(intxSchema.agentInstance.id, instanceId),
      });
      if (!instance) {
        return c.json({ error: "Instance not found" }, 404);
      }

      const { context: userContext, forbidden } = await getRequestedUserContext(
        db,
        userId,
        instance.tenantId,
      );
      if (forbidden || !userContext) {
        return c.json({ error: "Instance not accessible" }, 403);
      }

      // Tenant membership alone is not enough — the caller must own this
      // instance, or member A could parse (and pay) against member B's Myra.
      const ownership = await db.query.memberAgentInstance.findFirst({
        where: and(
          eq(memberAgentInstance.instanceId, instanceId),
          eq(memberAgentInstance.memberPrincipalId, userContext.principalId),
        ),
      });
      if (!ownership) {
        return c.json({ error: "Instance not accessible" }, 403);
      }

      // Validate the type at this trust boundary — the composer checks it
      // client-side, but the server must not store an unsupported or
      // parameter-bearing MIME (which would also break the data-URL round-trip).
      const mimeType = parsed.mimeType.split(";")[0]!.trim().toLowerCase();
      if (!isAllowedMimeType(mimeType)) {
        return c.json({ error: "Unsupported document type" }, 415);
      }
      if (!isValidBase64(parsed.data)) {
        return c.json({ error: "Document data is not valid base64" }, 400);
      }

      const bytes = new Uint8Array(Buffer.from(parsed.data, "base64"));
      if (bytes.length === 0) {
        return c.json({ error: "Document data is not valid base64" }, 400);
      }
      if (bytes.length > MAX_PARSE_FILE_BYTES) {
        return c.json(
          { error: "Document exceeds the maximum allowed size" },
          413,
        );
      }

      // Parse before storing so a failed parse never leaves an orphan artifact.
      // The artifact id is generated up front so the parse's durable audit tree
      // is keyed to the artifact it will become.
      const artifactId = randomUUID();
      let parsedText: string;
      try {
        parsedText = await withParseTimeout(
          parseDocument(db, {
            tenantId: userContext.tenantId,
            traceId: artifactId,
            filename: parsed.filename,
            mimeType,
            bytes,
          }),
        );
      } catch (err) {
        if (err instanceof ParseTimeoutError) {
          log.warn("Document parse timed out", { instanceId, artifactId });
          return c.json(
            { error: "The document took too long to parse. Try again." },
            504,
          );
        }
        if (err instanceof FileParseError) {
          log.warn("Document parse failed", {
            instanceId,
            artifactId,
            error: err.message,
          });
          return c.json({ error: err.message }, 502);
        }
        log.error("Document parse errored", {
          instanceId,
          artifactId,
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ error: "The document could not be parsed." }, 502);
      }

      const content = `data:${mimeType};base64,${parsed.data}`;
      const source = {
        origin: "imported" as const,
        upload: { filename: parsed.filename, mimeType },
      };
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.insert(artifact).values({
          id: artifactId,
          tenantId: userContext.tenantId,
          principalId: userContext.principalId,
          ownerPrincipalId: userContext.principalId,
          sessionId: null,
          kind: "file",
          title: parsed.filename,
          content,
          source,
          status: "draft",
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(artifactVersion).values({
          artifactId,
          version: 1,
          title: parsed.filename,
          content,
          authorId: userContext.principalId,
          createdAt: now,
        });
      });

      log.info("Parsed uploaded document for instance", {
        instanceId,
        artifactId,
        tenantId: userContext.tenantId,
      });

      return c.json({ artifactId, filename: parsed.filename, parsedText }, 201);
    },
  );

  return router;
}
