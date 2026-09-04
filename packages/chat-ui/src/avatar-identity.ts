/**
 * Approved Corbits pastel palette for avatars:
 * 1. Summit Blue: #C5D2DE
 * 2. Ridge Green: #C1D1BE
 * 3. Canvas Cream: #F7EAD5
 * 4. Breakthrough Orange: #F2B277
 */
export const PASTEL_PALETTE = [
  "#C5D2DE", // Summit Blue
  "#C1D1BE", // Ridge Green
  "#F7EAD5", // Canvas Cream
  "#F2B277", // Breakthrough Orange
] as const;

export type PastelColor = (typeof PASTEL_PALETTE)[number];

/**
 * A person's generated fallback fill for react-ui's `Avatar`, which has no
 * `style` prop — only `className` — because its own tone system is a
 * closed enum reserved for agent identity (`AvatarTone`). These two CSS
 * custom properties are meant to be set on an ancestor element (they
 * inherit down the DOM to the `Avatar`'s own root span, which reads them
 * back through the `avatar-identity-generated` class in `app.css`) rather
 * than passed as a prop react-ui doesn't accept.
 */
export type GeneratedAvatarStyle = {
  readonly "--avatar-identity-bg": string;
  readonly "--avatar-identity-fg": string;
};

/** The className that reads `GeneratedAvatarStyle`'s custom properties
 * back into an actual background/text pair. Apply to the `Avatar` itself
 * (or the bespoke `.chat-presence-avatar` chip); the style values belong
 * on an ancestor. */
export const AVATAR_IDENTITY_CLASS = "avatar-identity-generated";

const HEX_PATTERN = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i;
const HSL_PATTERN =
  /^hsl\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%\)$/;

function hslToRgb(
  h: number,
  s: number,
  l: number,
): readonly [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) =>
    light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [
    Math.round(f(0) * 255),
    Math.round(f(8) * 255),
    Math.round(f(4) * 255),
  ];
}

function parseColorToRgb(
  color: string,
): readonly [number, number, number] | null {
  const hexMatch = HEX_PATTERN.exec(color);
  if (hexMatch !== null) {
    const r = hexMatch[1];
    const g = hexMatch[2];
    const b = hexMatch[3];
    if (r !== undefined && g !== undefined && b !== undefined) {
      return [
        Number.parseInt(r, 16),
        Number.parseInt(g, 16),
        Number.parseInt(b, 16),
      ];
    }
  }
  const hslMatch = HSL_PATTERN.exec(color);
  if (hslMatch !== null) {
    const [, h, s, l] = hslMatch;
    return hslToRgb(Number(h), Number(s), Number(l));
  }
  return null;
}

function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * The legible initials color (pure black or pure white — never a
 * mid-tone) for a background, chosen by WCAG relative luminance so a
 * generated avatar stays readable.
 */
export function readableTextOn(background: string): string {
  const rgb = parseColorToRgb(background);
  if (rgb === null) return "#000000";
  const [r, g, b] = rgb;
  return relativeLuminance(r, g, b) > 0.4 ? "#000000" : "#ffffff";
}

/**
 * Deterministic hash of a principal ID string.
 */
export function hashPrincipal(principalId: string): number {
  let hash = 0;
  for (let index = 0; index < principalId.length; index += 1) {
    hash = (hash * 31 + principalId.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/**
 * Stable, per-person light pastel background fill from the approved
 * Corbits palette. Never swings arbitrary saturated hues.
 */
export function pastelColorForPrincipal(principalId: string): PastelColor {
  const hash = hashPrincipal(principalId);
  const index = hash % PASTEL_PALETTE.length;
  return PASTEL_PALETTE[index] ?? PASTEL_PALETTE[0];
}

/**
 * A stable, per-principal fill for a human's fallback avatar.
 * Uses a deterministic selection from the Workbench light-pastel palette
 * paired with a computed readable text color.
 * The same `principalId` always resolves to the same pair, in every
 * surface, for every viewer.
 */
export function generatedAvatarStyle(
  principalId: string,
): GeneratedAvatarStyle {
  const background = pastelColorForPrincipal(principalId);
  return {
    "--avatar-identity-bg": background,
    "--avatar-identity-fg": readableTextOn(background),
  };
}

export type AvatarFill =
  | { readonly kind: "image"; readonly url: string }
  | { readonly kind: "generated"; readonly style: GeneratedAvatarStyle };

/**
 * Which fallback an avatar should render: an explicit image always wins
 * over the generated fill, when one is on hand (e.g. `UserProfile.image`
 * from better-auth) — the generated look is a fallback, not a
 * replacement for a real picture.
 */
export function resolveAvatarFill(
  principalId: string,
  explicitImageUrl?: string | null,
): AvatarFill {
  if (
    explicitImageUrl !== undefined &&
    explicitImageUrl !== null &&
    explicitImageUrl.length > 0
  ) {
    return { kind: "image", url: explicitImageUrl };
  }
  return { kind: "generated", style: generatedAvatarStyle(principalId) };
}
