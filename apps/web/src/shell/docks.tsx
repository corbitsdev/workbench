// The initials helper the sidebar's account affordance renders from. The
// switcher dock this file used to also export (`BenchDock`) is gone — see
// `sidebar.tsx`'s header comment.

// Derived locally — CSP-strict, so never a network fetch for an avatar.
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
