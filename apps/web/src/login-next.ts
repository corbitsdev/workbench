// CL-6369: URLs tell the truth. The `next` query param carries where a
// signed-out visit was headed so a successful sign-in returns there — but
// it's attacker-controllable (a crafted `/login?next=...` link), so it must
// resolve to an in-app path or nowhere at all. Never an open redirect.

import { LOGIN_PATH } from "./routes";

export function buildLoginRedirect(path: string): string {
  return `${LOGIN_PATH}?next=${encodeURIComponent(path)}`;
}

/** Same-origin in-app path only. Rejects absolute URLs, protocol-relative
 * paths (`//host/...`), backslash tricks browsers treat as
 * protocol-relative (`/\host/...`), and a loop back to `/login` itself —
 * falling back to `/` in every rejected case. */
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
