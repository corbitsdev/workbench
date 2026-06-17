const MD_IMAGE_RE = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g;
const BARE_IMAGE_URL_RE =
  /(?:^|(?<=\s))(https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?\S*)?)(?=\s|$)/gim;

/**
 * Extracts image URLs from text content — both markdown image syntax and bare
 * image-extension URLs — returning cleaned text with those entries removed and
 * the list of URLs to render as standalone image cards.
 *
 * Only called on settled (non-streaming) agent messages.
 */
export function extractImageURLs(text: string): { cleanedText: string; urls: string[] } {
  const seen = new Set<string>();
  const urls: string[] = [];

  function pushUnique(url: string) {
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }

  let cleaned = text.replace(MD_IMAGE_RE, (_match, url: string) => {
    pushUnique(url);
    return '';
  });

  cleaned = cleaned.replace(BARE_IMAGE_URL_RE, (_match, url: string) => {
    pushUnique(url);
    return '';
  });

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return { cleanedText: cleaned, urls };
}
