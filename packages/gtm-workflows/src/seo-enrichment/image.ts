import { extname } from 'node:path';
import type { ImageBlock } from '@intx/types/runtime';

export type ImageLoadResult = { ok: true; image: ImageBlock } | { ok: false; reason: string };

type FetchLike = (url: string) => Promise<Response>;

const EXTENSION_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function mimeFromUrl(url: string): string | undefined {
  const path = url.split('?')[0] ?? url;
  return EXTENSION_MIME[extname(path).toLowerCase()];
}

// Cap the bytes we will pull from a remote image. The image links come from a
// user-uploaded spreadsheet, so a malicious or broken URL must not stream an
// unbounded body into memory.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Reject any host that is not a public https endpoint. The URL is attacker-
// controlled (a spreadsheet cell), so without this the hub becomes an SSRF
// proxy against cloud metadata (169.254.169.254) and internal services
// (localhost, private ranges). Hostname-literal IPs are checked here; this does
// not resolve DNS, so it is a guard, not a full SSRF defense — pair with egress
// controls in production.
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local')) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))
    return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

function disallowedReason(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid url';
  }
  if (parsed.protocol !== 'https:') return 'image url must be https';
  if (isBlockedHost(parsed.hostname)) return 'image url host is not allowed';
  return undefined;
}

// Resolve a product's `Image Link` URL into a base64 ImageBlock. Base64 is the
// provider-agnostic representation both Gemini and OpenAI accept, which is what
// the generate path consumes. The loader is called per row during fan-out, so
// bytes are materialized on demand rather than held for the whole batch.
//
// An absent or unreachable image is returned as a flagged failure, never thrown:
// one broken image must not abort a batch fan-out.
export async function loadProductImage(
  url: string,
  fetchImpl: FetchLike = fetch
): Promise<ImageLoadResult> {
  if (url === '') {
    return { ok: false, reason: 'no image link' };
  }

  const blocked = disallowedReason(url);
  if (blocked !== undefined) {
    return { ok: false, reason: blocked };
  }

  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    return {
      ok: false,
      reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return { ok: false, reason: `fetch returned HTTP ${response.status}` };
  }

  // The Knot's images route through a CDN proxy that may answer with
  // application/octet-stream or no content-type. Trust an explicit image/* type,
  // fall back to the URL extension otherwise, and only reject a response that
  // clearly is not an image (e.g. an HTML error page).
  const contentType = response.headers.get('content-type') ?? '';
  const headerMime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  let mimeType: string;
  if (headerMime.startsWith('image/')) {
    mimeType = headerMime;
  } else if (headerMime === '' || headerMime === 'application/octet-stream') {
    mimeType = mimeFromUrl(url) ?? 'image/jpeg';
  } else {
    return { ok: false, reason: `unexpected content-type "${contentType}"` };
  }

  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    return { ok: false, reason: 'image exceeds size limit' };
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    return { ok: false, reason: 'empty image response' };
  }
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, reason: 'image exceeds size limit' };
  }

  return {
    ok: true,
    image: {
      type: 'image',
      source: {
        kind: 'base64',
        mimeType,
        data: Buffer.from(buffer).toString('base64'),
      },
    },
  };
}
