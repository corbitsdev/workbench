import { useQuery } from "@tanstack/react-query";
import { brandsApi, brandLogoEndpoint } from "../lib/brands";

/**
 * Fetch a provider's brand logo SVG from the brands API with the API key in a
 * header (kept out of the URL/logs). Returns the raw SVG markup. The query is
 * disabled — and the caller falls back to a glyph — when the brands API is
 * unconfigured or we have no filename for the provider. Logos are immutable, so
 * the result is cached for the session.
 */
export function useProviderLogo(filename: string | null) {
  return useQuery({
    queryKey: ["brand-logo", filename],
    enabled: brandsApi.enabled && filename !== null,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    queryFn: async (): Promise<string> => {
      const res = await fetch(brandLogoEndpoint(filename as string), {
        headers: { "x-api-key": brandsApi.key },
      });
      if (!res.ok) {
        throw new Error(`Logo request failed: ${res.status}`);
      }
      const body = await res.text();
      // Guard the trust boundary: a 200 with a non-SVG body (HTML error page,
      // login redirect, empty) must degrade to the glyph, not a broken <img>.
      if (!body.includes("<svg")) {
        throw new Error("Logo response was not an SVG");
      }
      return body;
    },
  });
}
