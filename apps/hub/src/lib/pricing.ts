import { getPriceCatalog, type PriceCatalog } from "@workbench/pricing";

import { loadConfig } from "../config";

/**
 * Hub-side models.dev integration (CL-2714). Fetches and caches the pricing
 * catalog and proxies provider logos so the browser never reaches models.dev
 * directly (CSP + keeps the payload same-origin). Caching is in-process — the
 * hub has no redis (see docs/ANALYTICS.md).
 */

export async function loadPriceCatalog(): Promise<PriceCatalog> {
  const { pricing } = loadConfig();
  return getPriceCatalog({
    url: pricing.apiUrl,
    ttlMs: pricing.ttlMs,
    timeoutMs: pricing.fetchTimeoutMs,
  });
}

interface LogoEntry {
  /** `null` records a negatively-cached miss (404 or non-SVG body). */
  svg: string | null;
  fetchedAt: number;
}

/**
 * A miss (no logo for the provider) is cached only briefly so a provider that
 * gains a logo later is picked up soon, while a stable-missing provider is not
 * re-fetched from models.dev on every mount.
 */
const NEGATIVE_TTL_MS = 5 * 60_000;

const logoCache = new Map<string, LogoEntry>();
let logoInflight = new Map<string, Promise<string | null>>();

/** Test-only: clears the provider-logo cache. */
export function resetProviderLogoCache(): void {
  logoCache.clear();
  logoInflight = new Map();
}

const SVG_MARKER = "<svg";

async function fetchLogo(
  provider: string,
  fetchImpl: typeof fetch,
  now: number,
  timeoutMs: number,
): Promise<string | null> {
  const { pricing } = loadConfig();
  const url = `${pricing.logosBaseUrl}/${encodeURIComponent(provider)}.svg`;
  let svg: string | null = null;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      const body = await response.text();
      if (body.includes(SVG_MARKER)) svg = body;
    }
  } catch {
    svg = null;
  }
  logoCache.set(provider, { svg, fetchedAt: now });
  return svg;
}

function logoEntryFresh(entry: LogoEntry, now: number, ttlMs: number): boolean {
  const ttl = entry.svg === null ? NEGATIVE_TTL_MS : ttlMs;
  return now - entry.fetchedAt < ttl;
}

/**
 * Returns the SVG markup for a provider logo, cached in-process for the pricing
 * TTL. Returns `null` when models.dev has no logo for the provider (a 404, a
 * non-SVG body, or a timed-out/failed fetch); a miss is negatively cached for a
 * short window so a missing provider does not re-hit upstream on every mount.
 * The caller falls back to a glyph rather than surfacing an error.
 */
export async function getProviderLogo(
  provider: string,
  deps?: { fetchImpl?: typeof fetch; now?: () => number },
): Promise<string | null> {
  const { pricing } = loadConfig();
  const now = (deps?.now ?? Date.now)();
  const cached = logoCache.get(provider);
  if (cached !== undefined && logoEntryFresh(cached, now, pricing.ttlMs)) {
    return cached.svg;
  }
  const existing = logoInflight.get(provider);
  if (existing !== undefined) return existing;

  const fetchImpl = deps?.fetchImpl ?? fetch;
  const promise = fetchLogo(
    provider,
    fetchImpl,
    now,
    pricing.fetchTimeoutMs,
  ).finally(() => {
    logoInflight.delete(provider);
  });
  logoInflight.set(provider, promise);
  return promise;
}
