import { type } from "arktype";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The single UUID validator for hub route params. Routes validate an `:id`
// through this schema and return 400 on a malformed value; `isUuid` is the
// boolean form for callers that only need the predicate. Matches any RFC-shaped
// UUID (lenient on version/variant) so prefixed and legacy ids keep validating.
export const UuidParam = type(UUID_PATTERN);

export function isUuid(value: string): boolean {
  return !(UuidParam(value) instanceof type.errors);
}
