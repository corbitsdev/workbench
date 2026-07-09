export type ShortcutPlatform = "mac" | "non-mac";

export function detectShortcutPlatform(
  platform: string | undefined,
): ShortcutPlatform {
  if (platform === undefined) {
    return typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad|iPod/.test(navigator.platform)
      ? "mac"
      : "non-mac";
  }
  return /Mac|iPhone|iPad|iPod/.test(platform) ? "mac" : "non-mac";
}

export function modifierKeyLabel(platform: ShortcutPlatform): string {
  return platform === "mac" ? "⌘" : "Ctrl";
}

export function formatChord(key: string, platform: ShortcutPlatform): string {
  const mod = modifierKeyLabel(platform);
  const normalized = key.length === 1 ? key.toUpperCase() : key;
  if (platform === "mac") {
    return `${mod}${normalized}`;
  }
  return `${mod}+${normalized}`;
}

export interface PaletteShortcutHint {
  label: string;
  keys: string;
}

export const PALETTE_GLOBAL_SHORTCUT_HINTS: readonly PaletteShortcutHint[] = [
  { label: "Open command palette", keys: "K" },
  { label: "Attach to Myra", keys: "I" },
] as const;

export const PALETTE_LOCAL_SHORTCUT_HINTS: readonly PaletteShortcutHint[] = [
  { label: "Navigate", keys: "↑↓" },
  { label: "Select", keys: "↵" },
  { label: "Close", keys: "Esc" },
] as const;
