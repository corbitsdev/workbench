/** App-local event so the rail Search control can open the command palette
 * without coupling rail.tsx to CommandPaletteProvider state. */

export const OPEN_COMMAND_PALETTE_EVENT = "workbench:open-command-palette";

export function requestOpenCommandPalette(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
}
