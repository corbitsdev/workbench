/**
 * Minimal reproducer for a defect in @intx/mime's part-walking API.
 *
 * API path: `extractPartByPath` (exported from `@intx/mime`, vendored at
 * vendor/intx/mime/src/mime.ts) delegates internally to the unexported
 * `walkParts` (vendor/intx/mime/src/mime.ts:709-745). For a *leaf* part
 * path (the final path segment), `walkParts` returns the raw multipart
 * slice produced by `parseMultipart` (mime.ts:738-739) instead of the
 * parsed, transfer-decoded body every non-leaf depth already produces via
 * `parseMimePart`.
 *
 * This mirrors how packages/chat/src/platform-adapter.ts uses the API:
 * fetchBlob() calls `extractPartByPath(mailRow.raw, partPath)` with a path
 * like "1.2" (attachment part 2 inside the multipart/mixed signed content).
 *
 * Run: bun run scripts/repro/walkparts-repro.ts
 * No database, no network, no env vars.
 */

import {
  assembleMessage,
  assembleSignedContent,
  extractPartByPath,
  type MessageHeaders,
} from "../../vendor/intx/mime/src/index.ts";

const attachmentText = "hello attachment body";

// One text part + one attachment part; `MessageAttachment.data` is raw
// bytes — `assembleConversationSignedPart` base64-encodes it itself when
// writing the Content-Transfer-Encoding: base64 part.
const signedContentBytes = assembleSignedContent({
  kind: "conversation",
  text: "hello world",
  attachments: [
    {
      contentType: "text/plain",
      name: "note.txt",
      data: new TextEncoder().encode(attachmentText),
    },
  ],
});

// extractPartByPath doesn't verify the signature, so a placeholder
// signature is enough to produce a well-formed multipart/signed message.
const signatureBytes = new TextEncoder().encode(
  "-----BEGIN PGP SIGNATURE-----\nnot a real signature\n-----END PGP SIGNATURE-----",
);

const headers: MessageHeaders = {
  from: "sender@example.com",
  to: ["recipient@example.com"],
  cc: undefined,
  date: new Date("2026-08-06T00:00:00Z"),
  messageId: "<repro@example.com>",
  subject: "walkParts repro",
  inReplyTo: undefined,
  references: undefined,
  mimeVersion: "1.0",
  interchangeType: undefined,
  interchangeCorrelationId: undefined,
  interchangeTenantId: undefined,
  interchangeAgentId: undefined,
  interchangeSessionId: undefined,
  interchangeOfferingId: undefined,
  interchangeSchemaVersion: undefined,
  traceparent: undefined,
  tracestate: undefined,
};

const raw = assembleMessage(headers, signedContentBytes, signatureBytes);

// Path "1.2": part 1 of the outer multipart/signed message (the signed
// multipart/mixed content), then part 2 of that (the attachment) — the
// same path shape platform-adapter.ts's fetchBlob() passes through.
const leafBytes = extractPartByPath(raw, "1.2");
const actual = new TextDecoder().decode(leafBytes);

console.log("=== expected (decoded attachment body) ===");
console.log(JSON.stringify(attachmentText));

console.log("\n=== actual (extractPartByPath('1.2') result) ===");
console.log(JSON.stringify(actual));

const looksLikeRawMimeSlice = /^content-/im.test(actual);
console.log(`\nactual still contains MIME headers: ${looksLikeRawMimeSlice}`);
if (!looksLikeRawMimeSlice || actual === attachmentText) {
  throw new Error(
    "reproducer did not demonstrate the defect — actual output no longer includes raw headers",
  );
}
