/** Prefix scopes the palette input recognizes: `#` channels, `@` people &
 * agents, `>` actions, `/` pages. Typing one of these as the first character
 * narrows results to that kind and strips the prefix from the match text. */
export type PaletteScopeKind = "channels" | "people" | "actions" | "pages";

export type PaletteScope = {
  readonly prefix: string;
  readonly kind: PaletteScopeKind;
  readonly label: string;
};

export const PALETTE_SCOPES: readonly PaletteScope[] = [
  { prefix: "#", kind: "channels", label: "channels" },
  { prefix: "@", kind: "people", label: "people & agents" },
  { prefix: ">", kind: "actions", label: "actions" },
  { prefix: "/", kind: "pages", label: "pages" },
];

export type ParsedPaletteQuery = {
  /** `null` when the raw query does not start with a recognized prefix. */
  readonly scope: PaletteScope | null;
  /** The query text with the scope prefix (if any) stripped and trimmed. */
  readonly query: string;
};

/** Splits a raw palette input into its scope (if the first character is a
 * recognized prefix) and the remaining search text. Pure — no DOM, no state. */
export function parsePaletteQuery(raw: string): ParsedPaletteQuery {
  const scope =
    PALETTE_SCOPES.find((candidate) => candidate.prefix === raw.slice(0, 1)) ??
    null;
  const query = (scope === null ? raw : raw.slice(scope.prefix.length)).trim();
  return { scope, query };
}
