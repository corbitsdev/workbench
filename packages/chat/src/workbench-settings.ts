// The workbench-settings vocabulary: reading `chat/*` keys back off a
// settings jsonb blob (kind, context window, participants), rendering
// the caller-facing workbench view, and validating a settings PATCH
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

// `chat/contextWindow` is nullable: `null` (or the key's absence) means
// "inherit the bench-wide default", a number is an explicit per-workbench
// override. This is the Discord "use server default" shape — see
// `resolveContextWindow` below for how the two are told apart and folded
// into one effective value.
export const ChatNamespaceSchemas: Readonly<Record<string, Type<unknown>>> = {
  "chat/kind": type("string"),
  "chat/name": type("string"),
  "chat/purpose": type("string"),
  "chat/pinned": type("boolean"),
  "chat/participants": ParticipantsSetting,
  "chat/contextWindow": type("number | null"),
  "chat/visibility": type("'bench' | 'members'"),
};

// The bench-wide chat defaults vocabulary: currently just the default
// context window every workbench inherits unless it sets its own override.
// Kept as its own schema table (rather than folded into
// `ChatNamespaceSchemas`) because a bench default is never nullable — there
// is nothing beneath it to inherit from.
export const ChatBenchNamespaceSchemas: Readonly<
  Record<string, Type<unknown>>
> = {
  "chat/contextWindow": type("number"),
};

export class SettingsValidationError extends Error {}

function validatePatchAgainst(
  body: unknown,
  schemas: Readonly<Record<string, Type<unknown>>>,
  namespace: string,
): Record<string, unknown> {
  const parsed = PatchSettingsBody(body);
  if (parsed instanceof type.errors) {
    throw new SettingsValidationError(
      `settings patch must be an object: ${parsed.summary}`,
    );
  }
  const validated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith(namespace)) {
      const schema = schemas[key];
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
 * Validates a settings PATCH payload: `chat/*` keys are checked
 * against the package's own strict schema per key, while any other
 * `<pkg>/*` namespace passes through opaquely. That asymmetry is the
 * extension contract, not a fallback — a foreign package's settings
 * are simply not this package's to validate.
 */
export function validateSettingsPatch(body: unknown): Record<string, unknown> {
  return validatePatchAgainst(body, ChatNamespaceSchemas, "chat/");
}

/**
 * Validates a bench-wide settings PATCH payload the same way
 * `validateSettingsPatch` validates a workbench's, against the bench
 * defaults vocabulary instead. A bench default carries no inherit case of
 * its own, so every `chat/*` key here is required to be its real type,
 * never `null`.
 */
export function validateBenchSettingsPatch(
  body: unknown,
): Record<string, unknown> {
  return validatePatchAgainst(body, ChatBenchNamespaceSchemas, "chat/");
}

/**
 * A workbench's kind, read off its settings — the same "settings is the
 * source of truth" surface `participantsOf` reads. Defaults to
 * `"chat"` for a settings blob carrying no `chat/kind` at all, matching
 * `presetForKind`'s unrecognized-kind default.
 */
export function kindOf(settings: Record<string, unknown>): string {
  const kind = settings["chat/kind"];
  return typeof kind === "string" ? kind : "chat";
}

/** Default workbench-context window (in prior text messages) when a
 * workbench's settings carry no `chat/contextWindow` at all. */
export const DEFAULT_CONTEXT_WINDOW = 20;

/** Upper clamp on `chat/contextWindow`, so a bad or malicious setting
 * value can never turn a mention fan-out into a token bomb. */
export const MAX_CONTEXT_WINDOW = 200;

function clampWindow(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return undefined;
  }
  return Math.min(raw, MAX_CONTEXT_WINDOW);
}

/**
 * A workbench's context-window size, read off its settings the same way
 * `kindOf` reads kind: a non-negative integer, where `0` disables the
 * workbench-context block entirely. Absent or invalid values (wrong type,
 * negative, non-integer, `null`) fall back to `DEFAULT_CONTEXT_WINDOW`
 * rather than trusting the jsonb shape; anything above
 * `MAX_CONTEXT_WINDOW` is clamped down to it — validation at the trust
 * boundary, not a fallback path.
 *
 * This reads the code-level default directly, with no notion of a
 * bench-wide override — callers that have a bench default in hand should
 * use `resolveContextWindow` instead, which is the inherit/override-aware
 * successor to this function.
 */
export function contextWindowOf(settings: Record<string, unknown>): number {
  return clampWindow(settings["chat/contextWindow"]) ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * A bench's default context window, read off its bench-wide settings the
 * same way `contextWindowOf` reads a workbench's: absent or invalid falls
 * back to `DEFAULT_CONTEXT_WINDOW`, and anything oversized clamps to
 * `MAX_CONTEXT_WINDOW`. A bench default is never itself "inherited" —
 * there is nothing beneath it — so this never returns a null/override
 * distinction, only a plain number.
 */
export function benchContextWindowOf(
  settings: Record<string, unknown>,
): number {
  return clampWindow(settings["chat/contextWindow"]) ?? DEFAULT_CONTEXT_WINDOW;
}

export type ContextWindowSource = "inherit" | "override";

export interface ResolvedContextWindow {
  readonly value: number;
  readonly source: ContextWindowSource;
}

const BenchDefaultInput = type("number.integer >= 0");

/**
 * Folds a workbench's `chat/contextWindow` override against its bench's
 * default into the one effective value a message send actually uses —
 * the "Use bench default" vs "Override" distinction the workbench settings
 * panel renders as a two-state control.
 *
 * `null` or an absent key on the workbench means inherit: the resolved
 * value is the bench default, clamped the same way a workbench override
 * would be. Any other valid number is an explicit override, clamped to
 * `MAX_CONTEXT_WINDOW` on its own. An invalid override (wrong type,
 * negative, non-integer) is treated the same as absent — it inherits,
 * rather than silently coercing to some other number.
 *
 * `benchDefault` is trusted to already be a valid, clamped context
 * window (as `benchContextWindowOf` produces) — this throws loudly
 * rather than accepting a malformed bench default, since a bad bench
 * default would otherwise silently corrupt every inheriting workbench's
 * effective value.
 */
export function resolveContextWindow(
  workbenchSettings: Record<string, unknown>,
  benchDefault: number,
): ResolvedContextWindow {
  const validatedDefault = BenchDefaultInput(benchDefault);
  if (validatedDefault instanceof type.errors) {
    throw new Error(
      `resolveContextWindow: invalid bench default: ${validatedDefault.summary}`,
    );
  }
  const clampedDefault = Math.min(validatedDefault, MAX_CONTEXT_WINDOW);

  const raw = workbenchSettings["chat/contextWindow"];
  if (raw === undefined || raw === null) {
    return { value: clampedDefault, source: "inherit" };
  }
  const override = clampWindow(raw);
  if (override === undefined) {
    return { value: clampedDefault, source: "inherit" };
  }
  return { value: override, source: "override" };
}

export type WorkbenchVisibility = "bench" | "members";

/**
 * A workbench's visibility, read off its settings the same way `kindOf`
 * reads kind: `"bench"` — every member of the owning bench opens it —
 * unless the creator has explicitly flipped it to `"members"` (CL-6332),
 * where only principals the workbench's own child tenant has minted may.
 * Defaults to `"bench"` for any other or absent value, never fails
 * closed to `"members"` from a malformed setting.
 */
export function visibilityOf(
  settings: Record<string, unknown>,
): WorkbenchVisibility {
  return settings["chat/visibility"] === "members" ? "members" : "bench";
}

export function participantsOf(
  settings: Record<string, unknown>,
): ParticipantRecord[] {
  return parseParticipants(settings["chat/participants"]);
}

export function workbenchView(row: {
  readonly workbenchId: string;
  readonly settings: Record<string, unknown>;
}): {
  id: string;
  title: string;
  kind: string;
  pinned: boolean;
  definitionId: string | null;
  participants: ParticipantRecord[];
} {
  const kind = kindOf(row.settings);
  const name = row.settings["chat/name"];
  const pinned = row.settings["chat/pinned"];
  const definitionId = row.settings["chat/definitionId"];
  return {
    id: row.workbenchId,
    title: typeof name === "string" ? name : row.workbenchId,
    kind,
    pinned: typeof pinned === "boolean" ? pinned : presetForKind(kind).pinned,
    // The agent this chat was minted for — the client's signal that an
    // empty chat whose greeting hasn't landed yet is still SETTING UP
    // rather than idle.
    definitionId: typeof definitionId === "string" ? definitionId : null,
    participants: participantsOf(row.settings),
  };
}
