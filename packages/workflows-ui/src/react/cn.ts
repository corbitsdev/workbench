/** Minimal className join — no clsx/twMerge dep; callers pass complete Tailwind classes. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
