// Pure helpers for the bench-wide "default conversation memory" control:
// turning the raw `chat/contextWindow` bench default into friendly copy, and
// turning what someone types back into the integer the bench-settings PATCH
// route accepts. A bench default is never "inherited" — there is nothing
// beneath it — so unlike a channel's own context-window control, blank
// input here is not a valid state; it just isn't ready to submit yet. No
// fetching, no React — bare functions bun:test can hit directly.

import { SETTINGS_STRINGS } from "./strings";

export const CONTEXT_WINDOW_MIN = 0;
export const CONTEXT_WINDOW_MAX = 200;

/**
 * The friendly label for the bench's default context window: `0` disables
 * the context block entirely for any inheriting channel, and everything
 * else is read as "last N messages" — never the raw key name
 * `chat/contextWindow`.
 */
export function contextWindowLabel(value: number): string {
  if (value === 0) return SETTINGS_STRINGS.chatContextWindowDisabled;
  return SETTINGS_STRINGS.chatContextWindowCustom(value);
}

/**
 * What the bench-default text field should send on save: parsed as an
 * integer and clamped into `[0, 200]`. Returns `null` for input that isn't
 * ready to submit — blank, or not a whole number — which the caller treats
 * as "don't save yet" rather than silently coercing to 0.
 */
export function parseContextWindowInput(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Math.min(Math.max(parsed, CONTEXT_WINDOW_MIN), CONTEXT_WINDOW_MAX);
}
