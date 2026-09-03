// Inbound cookie-header parsing, shared by every route package that
// forwards a caller's session cookie into a self-HTTP call against the
// hub's native API. Sibling to `hub.ts`'s outbound cookie-jar logic
// (`createHubAPI`'s `Cookie` header join) but the other direction: a raw
// `Cookie` request header in, one string per `name=value` pair out.
export function cookiesFromHeader(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0);
}
