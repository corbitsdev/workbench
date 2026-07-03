import { type } from "arktype";

export const TimelineCursorSchema = type({
  timestamp: "string.date.iso",
  sourceTable: "string > 0",
  id: "string > 0",
});
export type TimelineCursor = typeof TimelineCursorSchema.infer;

export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeTimelineCursor(token: string): TimelineCursor {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch (cause) {
    throw new Error("Invalid timeline cursor token", { cause });
  }
  const parsed = TimelineCursorSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid timeline cursor: ${parsed.summary}`);
  }
  return parsed;
}
