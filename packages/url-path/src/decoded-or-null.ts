/** A URL path segment or param carries percent-escapes an id needs
 * decoded, and a hand-typed or truncated URL can carry a malformed one —
 * which `decodeURIComponent` answers with a throw. A segment that cannot
 * be decoded names no entity, so it reads as no selection at all rather
 * than taking the render — or the request — down with it. */
export function decodedOrNull(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
