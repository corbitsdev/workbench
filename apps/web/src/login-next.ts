// `next` is attacker-controllable (a crafted `/login?next=...` link), so
// it must resolve to an in-app path or nowhere — never an open redirect.

import { LOGIN_PATH } from "./routes";

export function buildLoginRedirect(path: string): string {
  return `${LOGIN_PATH}?next=${encodeURIComponent(path)}`;
}

/** Same-origin in-app path only — rejects absolute/protocol-relative URLs
 * and a loop back to `/login`, falling back to `/`. */
export function validatedNextPath(search: string): string {
  const next = new URLSearchParams(search).get("next");
  if (next === null) return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next.includes("://")) return "/";
  if (next === LOGIN_PATH || next.startsWith(`${LOGIN_PATH}/`)) return "/";
  if (next.startsWith(`${LOGIN_PATH}?`)) return "/";
  return next;
}
