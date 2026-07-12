import { parseHeaderSection } from "@intx/mime";

export type ParsedMailHeaders = {
  headers: Map<string, string>;
  bodyOffset: number;
};

// A stored/received frame whose header section the MIME parser rejects is
// the expected case here, not a swallowed fault: callers degrade to
// whatever cached data they have (list headers written at persist time, or
// an empty body) rather than failing the whole request for one malformed
// frame.
export function tryParseHeaderSection(
  raw: Uint8Array,
): ParsedMailHeaders | null {
  try {
    return parseHeaderSection(raw);
  } catch {
    return null;
  }
}
