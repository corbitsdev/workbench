// The initials helper the sidebar's account affordance renders from. The
// switcher dock this file used to also export (`BenchDock`) is gone — see
// `sidebar.tsx`'s header comment (CL-6089).

/**
 * Initials for the identity dock's avatar, derived locally — the app is
 * CSP-strict, so there is never a network fetch for an avatar image.
 * Prefers the account name; an account with no usable name falls back
 * to the email's local part, and "··" stands in when neither yields a
 * letter (mirroring the reference chrome's placeholder).
 */
export function initialsOf(name: string, email = ""): string {
  const source = name.trim().length > 0 ? name : (email.split("@")[0] ?? "");
  const initials = source
    .split(/[\s._-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return initials.length > 0 ? initials : "··";
}
