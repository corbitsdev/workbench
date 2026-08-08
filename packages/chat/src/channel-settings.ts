// The channel-settings vocabulary: reading `chat/*` keys back off a
// settings jsonb blob (kind, context window, participants), rendering
// the caller-facing channel view, and validating a settings PATCH
// payload at the trust boundary. `presetForKind` itself stays in
// `./kinds` (it has its own focused test file and no other settings
// dependency) — this module imports it rather than absorbing it, so
// the kind-preset table and the settings-reading functions each stay
// independently testable.
import { type, type Type } from "arktype";
import { presetForKind } from "./kinds";
import {
  parseParticipants,
  ParticipantsSetting,
  type ParticipantRecord,
} from "./participants";

const PatchSettingsBody = type("Record<string, unknown>");

export const ChatNamespaceSchemas: Readonly<Record<string, Type<unknown>>> = {
  "chat/kind": type("string"),
  "chat/name": type("string"),
  "chat/pinned": type("boolean"),
  "chat/participants": ParticipantsSetting,
  "chat/contextWindow": type("number"),
};

export class SettingsValidationError extends Error {}

/**
 * Validates a settings PATCH payload: `chat/*` keys are checked
 * against the package's own strict schema per key, while any other
 * `<pkg>/*` namespace passes through opaquely. That asymmetry is the
 * extension contract, not a fallback — a foreign package's settings
 * are simply not this package's to validate.
 */
export function validateSettingsPatch(body: unknown): Record<string, unknown> {
  const parsed = PatchSettingsBody(body);
  if (parsed instanceof type.errors) {
    throw new SettingsValidationError(
      `settings patch must be an object: ${parsed.summary}`,
    );
  }
  const validated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith("chat/")) {
      const schema = ChatNamespaceSchemas[key];
      if (schema === undefined) {
        throw new SettingsValidationError(`unknown chat setting "${key}"`);
      }
      const result = schema(value);
      if (result instanceof type.errors) {
        throw new SettingsValidationError(
          `invalid value for "${key}": ${result.summary}`,
        );
      }
      validated[key] = value;
    } else {
      validated[key] = value;
    }
  }
  return validated;
}

/**
 * A channel's kind, read off its settings — the same "settings is the
 * source of truth" surface `participantsOf` reads. Defaults to
 * `"chat"` for a settings blob carrying no `chat/kind` at all, matching
 * `presetForKind`'s unrecognized-kind default.
 */
export function kindOf(settings: Record<string, unknown>): string {
  const kind = settings["chat/kind"];
  return typeof kind === "string" ? kind : "chat";
}

/** Default channel-context window (in prior text messages) when a
 * channel's settings carry no `chat/contextWindow` at all. */
export const DEFAULT_CONTEXT_WINDOW = 20;

/** Upper clamp on `chat/contextWindow`, so a bad or malicious setting
 * value can never turn a mention fan-out into a token bomb. */
export const MAX_CONTEXT_WINDOW = 200;

/**
 * A channel's context-window size, read off its settings the same way
 * `kindOf` reads kind: a non-negative integer, where `0` disables the
 * channel-context block entirely. Absent or invalid values (wrong type,
 * negative, non-integer) fall back to `DEFAULT_CONTEXT_WINDOW` rather
 * than trusting the jsonb shape; anything above `MAX_CONTEXT_WINDOW` is
 * clamped down to it — validation at the trust boundary, not a
 * fallback path.
 */
export function contextWindowOf(settings: Record<string, unknown>): number {
  const raw = settings["chat/contextWindow"];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return DEFAULT_CONTEXT_WINDOW;
  }
  return Math.min(raw, MAX_CONTEXT_WINDOW);
}

export function participantsOf(
  settings: Record<string, unknown>,
): ParticipantRecord[] {
  return parseParticipants(settings["chat/participants"]);
}

export function channelView(row: {
  readonly channelId: string;
  readonly settings: Record<string, unknown>;
}): {
  id: string;
  title: string;
  kind: string;
  pinned: boolean;
  participants: ParticipantRecord[];
} {
  const kind = kindOf(row.settings);
  const name = row.settings["chat/name"];
  const pinned = row.settings["chat/pinned"];
  return {
    id: row.channelId,
    title: typeof name === "string" ? name : row.channelId,
    kind,
    pinned: typeof pinned === "boolean" ? pinned : presetForKind(kind).pinned,
    participants: participantsOf(row.settings),
  };
}
