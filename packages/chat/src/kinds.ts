// Workbench kind presets, as data rather than per-kind branching code. A
// kind string is caller-supplied and open-ended (extensibility: an
// unrecognized kind is still a valid workbench), so the lookup always
// resolves to a preset — known kinds via the table, anything else via
// the chat-like default — never by testing the kind string in an
// `if`/`switch` at the call site.

export interface WorkbenchKindPreset {
  /** Whether a workbench of this kind is pinned by default. */
  readonly pinned: boolean;
}

const KNOWN_KIND_PRESETS: Readonly<Record<string, WorkbenchKindPreset>> = {
  workbench: { pinned: true },
  chat: { pinned: false },
};

/** Applied to any kind string absent from `KNOWN_KIND_PRESETS`. */
const DEFAULT_KIND_PRESET: WorkbenchKindPreset = { pinned: false };

/**
 * Resolves the preset for a kind string. `"workbench"` and `"chat"` are
 * the platform's own presets; any other string is accepted data and
 * resolves to `DEFAULT_KIND_PRESET`, which mirrors `"chat"` — chat is
 * the throwaway, unprivileged default, so an unrecognized kind never
 * gains durability or pinning it wasn't declared for.
 */
export function presetForKind(kind: string): WorkbenchKindPreset {
  return KNOWN_KIND_PRESETS[kind] ?? DEFAULT_KIND_PRESET;
}
