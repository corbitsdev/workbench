import { and, eq, lt, or, type Column, type SQL } from "drizzle-orm";
import { type } from "arktype";

// Uniform keyset (seek) pagination for the owner-scoped list endpoints. Every
// paginated list orders by (createdAt DESC, id DESC) — id is the stable
// tiebreaker so a page boundary is deterministic even when two rows share a
// createdAt. A cursor is the opaque, base64url-encoded (createdAt, id) of the
// last row of the previous page; a page is fetched as limit+1 rows so the
// presence of an extra row is exactly "there is another page".

// The hard server ceiling on a page size, regardless of the requested limit.
export const MAX_PAGE_LIMIT = 200;

// The decoded keyset position. `createdAt` is an ISO-8601 string on the wire;
// it is converted to a Date only when it reaches the SQL comparison.
export const KeysetCursorSchema = type({
  createdAt: "string",
  id: "string",
});
export type KeysetCursor = typeof KeysetCursorSchema.infer;

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  const json = JSON.stringify({
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  });
  return Buffer.from(json, "utf8").toString("base64url");
}

// Decodes an opaque cursor back to its keyset position, returning null for any
// malformed input (bad base64, non-JSON, wrong shape, or an unparseable
// createdAt) so the route can answer 400 rather than trusting the value.
export function decodeCursor(raw: string): KeysetCursor | null {
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
  const result = KeysetCursorSchema(parsed);
  if (result instanceof type.errors) return null;
  if (Number.isNaN(new Date(result.createdAt).getTime())) return null;
  return result;
}

// Parses a raw `limit` query param: absent → the endpoint default, a positive
// integer → itself clamped to MAX_PAGE_LIMIT, anything else (non-integer, < 1)
// → null so the route can answer 400.
export function clampLimit(
  raw: string | undefined,
  opts: { default: number; max?: number },
): number | null {
  const max = opts.max ?? MAX_PAGE_LIMIT;
  if (raw === undefined) return opts.default;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, max);
}

// The `WHERE (createdAt, id) < (cursor.createdAt, cursor.id)` row-value
// comparison, written as an explicit or/and form for Postgres/PGlite
// portability rather than a raw tuple.
export function keysetBefore(
  createdAtCol: Column,
  idCol: Column,
  cursor: KeysetCursor,
): SQL | undefined {
  const at = new Date(cursor.createdAt);
  return or(
    lt(createdAtCol, at),
    and(eq(createdAtCol, at), lt(idCol, cursor.id)),
  );
}

// Given limit+1 rows fetched in keyset order, drops the sentinel extra row and
// derives nextCursor from the last KEPT row when another page exists.
export function takePage<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor?: string } {
  if (rows.length <= limit) return { items: rows };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  if (!last) return { items };
  return { items, nextCursor: encodeCursor(last) };
}
