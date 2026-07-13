// The OAuth redirect URI is derived from the hub's public base URL — it is NOT
// an owner-entered value. The owner registers THIS exact URI with the provider
// (Linear/Attio) when creating the OAuth app. Kept in one place so the
// authorize call, the token exchange, and the callback mount all agree.
export function oauthCallbackRedirectUri(
  base: string,
  provider: string,
): string {
  return `${base.replace(/\/$/, "")}/oauth/callback/${provider}`;
}
