// Config for the self-hosted brands API (provider logos). The key ships in the
// bundle, so it is coarse friction, not a secret — and CORS only constrains
// browser callers, not a direct request. We send it in a header (not the URL)
// so it stays out of the brands-api server's access logs and the Referer.
const base = (
  (import.meta.env.VITE_BRANDS_API_BASE as string | undefined) ?? ""
).replace(/\/$/, "");
const key = (import.meta.env.VITE_BRANDS_API_KEY as string | undefined) ?? "";

export const brandsApi = {
  base,
  key,
  // When unconfigured, the UI simply falls back to the generic glyph.
  enabled: base !== "" && key !== "",
};

export function brandLogoEndpoint(filename: string): string {
  return `${brandsApi.base}/svg/${filename}`;
}
