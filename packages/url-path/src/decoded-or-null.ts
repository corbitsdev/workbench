/** Decodes a URL path segment, reading a malformed one as no selection
 * rather than throwing. */
export function decodedOrNull(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
