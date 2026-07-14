import { MailboxInboxView } from "@workbench/shared";
import { type } from "arktype";
import { KeysetCursorSchema, type KeysetCursor } from "./keyset";

const MailboxListCursorSchema = KeysetCursorSchema.and(
  type({ view: MailboxInboxView }),
);

export type MailboxListCursor = KeysetCursor & {
  view: typeof MailboxInboxView.infer;
};

export function encodeMailboxListCursor(
  row: { createdAt: Date; id: string },
  view: MailboxListCursor["view"],
): string {
  const json = JSON.stringify({
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    view,
  });
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeMailboxListCursor(raw: string): MailboxListCursor | null {
  let json: string;
  try {
    json = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const result = MailboxListCursorSchema(parsed);
  if (result instanceof type.errors) return null;
  if (Number.isNaN(new Date(result.createdAt).getTime())) return null;
  return result;
}