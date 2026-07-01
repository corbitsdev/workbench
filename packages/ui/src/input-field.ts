// Shared class for text/textarea/select form fields across the app. Uses the
// `rounded-input` design token (9px) and the app's border/surface tokens so
// every form field reads consistently. Duplicating this string per-page is how
// radii drift (some used `rounded-sm`); import from here instead.
export const inputFieldClass =
  "w-full rounded-input border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange";
