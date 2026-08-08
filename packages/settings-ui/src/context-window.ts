// Pure helpers for the "conversation memory" control on a channel's
// settings: turning the raw `chat/contextWindow` number (or its absence)
// into friendly copy, and turning what someone types back into the integer
// the PATCH route accepts. No fetching, no React — bare functions bun:test
// can hit directly.

import { SETTINGS_STRINGS } from "./strings";

export const CONTEXT_WINDOW_MIN = 0;
export const CONTEXT_WINDOW_MAX = 200;

/**
 * The friendly label for a channel's context window: `0` disables the
 * context block entirely, `undefined` means the server's own default of 20
 * applies, and everything else is read as "last N messages" — never the
 * raw key name `chat/contextWindow`.
 */
export function contextWindowLabel(value: number | undefined): string {
  if (value === undefined) return SETTINGS_STRINGS.chatContextWindowDefault;
  if (value === 0) return SETTINGS_STRINGS.chatContextWindowDisabled;
  return SETTINGS_STRINGS.chatContextWindowCustom(value);
}

/**
 * What a context-window text field should send on save: blank input clears
 * the setting back to "default", and any other value is parsed as an
 * integer and clamped into `[0, 200]`. Returns `null` for input that parses
 * to nothing (not a number at all), which the caller treats as "not ready
 * to submit" rather than silently coercing to 0.
 */
export function parseContextWindowInput(
  input: string,
): number | undefined | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Math.min(Math.max(parsed, CONTEXT_WINDOW_MIN), CONTEXT_WINDOW_MAX);
}
