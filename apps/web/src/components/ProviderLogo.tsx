import {
  CATALOG_GLYPH_KINDS,
  CatalogGlyph,
  hashString,
  type CatalogGlyphKind,
} from "@workbench/ui";
import { useMemo } from "react";
import { providerLabel, providerLogoFile } from "../lib/tool-providers";
import { useProviderLogo } from "../hooks/use-provider-logo";

interface ProviderLogoProps {
  providerName: string;
  size?: number;
  className?: string;
  // Glyph to show when there is no brand logo. Defaults to a provider-stable
  // glyph. When `hideFallback` is set, nothing renders instead of a glyph
  // (used in dense surfaces like group headers where a generic glyph is noise).
  fallbackGlyph?: CatalogGlyphKind;
  hideFallback?: boolean;
}

/**
 * Renders a provider's brand logo from the brands API, falling back to the
 * generic `CatalogGlyph` when no mark exists or the fetch fails. The logo is
 * fetched (not an `<img src>` to the API) so the API key travels in a header.
 */
export function ProviderLogo({
  providerName,
  size = 44,
  className,
  fallbackGlyph,
  hideFallback = false,
}: ProviderLogoProps) {
  const filename = providerLogoFile(providerName);
  const { data } = useProviderLogo(filename);

  const dataUri = useMemo(
    () => (data ? `data:image/svg+xml,${encodeURIComponent(data)}` : null),
    [data],
  );

  if (dataUri === null) {
    if (hideFallback) {
      return null;
    }
    const glyphKind =
      fallbackGlyph ??
      CATALOG_GLYPH_KINDS[
        hashString(providerName) % CATALOG_GLYPH_KINDS.length
      ]!;
    return <CatalogGlyph kind={glyphKind} className={className} />;
  }

  return (
    <img
      src={dataUri}
      alt={`${providerLabel(providerName)} logo`}
      width={size}
      height={size}
      loading="lazy"
      className={className}
      style={{ width: size, height: size, objectFit: "contain" }}
    />
  );
}
