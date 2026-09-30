import { Avatar, AvatarStack, type AvatarStackItem, type AvatarTone } from "@corbits/react-ui";

import { agentInitials } from "@/chat/threads-api";

// Token references, not hex, so no product code hardcodes a color value.
export const AVATAR_COLORS = ["--avatar-1", "--avatar-2", "--avatar-3", "--avatar-4"] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];

export const CORBIT_DEFAULT_COLOR: AvatarColor = "--avatar-1";

// react-ui owns the fill; the token only picks which of its tones a
// principal lands on.
const TONE_BY_COLOR: Record<AvatarColor, AvatarTone> = {
  "--avatar-1": "agent",
  "--avatar-2": "agent2",
  "--avatar-3": "agent3",
  "--avatar-4": "neutral",
};

export const avatarColorClass: Record<AvatarColor, string> = {
  "--avatar-1": "bg-(--avatar-1) text-black",
  "--avatar-2": "bg-(--avatar-2) text-black",
  "--avatar-3": "bg-(--avatar-3) text-black",
  "--avatar-4": "bg-(--avatar-4) text-black",
};

export function hashPrincipal(principalId: string): number {
  let hash = 0;
  for (let index = 0; index < principalId.length; index += 1) {
    hash = (hash * 31 + principalId.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function avatarColorForPrincipal(principalId: string): AvatarColor {
  const hash = hashPrincipal(principalId);
  const index = hash % AVATAR_COLORS.length;
  const color = AVATAR_COLORS[index];
  if (color === undefined) {
    throw new Error("Avatar color palette is empty");
  }
  return color;
}

export function avatarClassForPrincipal(principalId: string): string {
  return avatarColorClass[avatarColorForPrincipal(principalId)];
}

export type AvatarFill =
  | { readonly kind: "image"; readonly url: string }
  | { readonly kind: "generated"; readonly className: string };

export function resolveAvatarFill(
  principalId: string,
  explicitImageUrl?: string | null,
): AvatarFill {
  if (explicitImageUrl !== undefined && explicitImageUrl !== null && explicitImageUrl.length > 0) {
    return { kind: "image", url: explicitImageUrl };
  }
  return { kind: "generated", className: avatarClassForPrincipal(principalId) };
}

export type CorbitAvatarSize = "xs" | "sm" | "md" | "lg" | "xl" | number;
export type AvatarStatus = "working" | "ready" | "idle";

// react-ui ships sm/md/lg only; the wrapper sizes xs/xl/numeric and the
// mark fills it.
const SIZE_PX = { xs: 16, sm: 24, md: 32, lg: 40, xl: 80 } as const;

function baseSize(px: number): "sm" | "md" | "lg" {
  if (px <= 24) return "sm";
  if (px <= 32) return "md";
  return "lg";
}

export interface WorkbenchAvatarProps {
  /** Workers are rounded squares, people circles. */
  readonly kind: "worker" | "person";
  readonly name: string;
  readonly tone?: AvatarTone;
  readonly size?: CorbitAvatarSize;
  readonly status?: AvatarStatus;
  readonly className?: string;
}

export function WorkbenchAvatar({
  kind,
  name,
  tone = "agent",
  size = "md",
  status,
  className,
}: WorkbenchAvatarProps) {
  const px = typeof size === "number" ? size : SIZE_PX[size];
  const radius = kind === "person" ? "50%" : `${Math.round(px * 0.28)}px`;
  const working = kind === "worker" && status === "working";
  return (
    <span
      className={["wb-av", className].filter(Boolean).join(" ")}
      data-kind={kind}
      {...(status === undefined ? {} : { "data-status": status })}
      style={{ width: px, height: px, ["--av-r" as string]: radius }}
    >
      <Avatar
        initials={agentInitials(name)}
        label={name}
        tone={tone}
        size={baseSize(px)}
        className="size-full! rounded-(--av-r)"
      />
      {working ? <span className="wb-av-orbit" aria-hidden="true" /> : null}
      {status === undefined || working ? null : (
        <span className={`wb-av-st wb-av-st--${status}`} aria-hidden="true" />
      )}
    </span>
  );
}

export interface CorbitAvatarProps {
  readonly ariaLabel?: string;
  readonly size?: CorbitAvatarSize;
  readonly color?: AvatarColor;
  readonly status?: AvatarStatus;
  readonly className?: string;
}

export function CorbitAvatar({
  ariaLabel = "Agent",
  size = "md",
  color = CORBIT_DEFAULT_COLOR,
  status,
  className,
}: CorbitAvatarProps) {
  return (
    <WorkbenchAvatar
      kind="worker"
      name={ariaLabel}
      tone={TONE_BY_COLOR[color]}
      size={size}
      {...(status === undefined ? {} : { status })}
      {...(className === undefined ? {} : { className })}
    />
  );
}

export function WorkbenchAvatarStack({
  items,
  max,
}: {
  readonly items: readonly AvatarStackItem[];
  readonly max?: number;
}) {
  return <AvatarStack items={items} {...(max === undefined ? {} : { max })} />;
}

// A person's color hashes off principal id, never name — DESIGN.md's avatar
// identity rule. A worker keeps the agent fill: each bench deploys its own
// copy with a new principal id, so hashing it would recolor one worker per
// bench.
export function IdentityAvatar({
  kind,
  name,
  principalId,
  status,
}: {
  readonly kind: "agent" | "person";
  readonly name: string;
  readonly principalId: string;
  readonly status?: AvatarStatus;
}) {
  return (
    <WorkbenchAvatar
      kind={kind === "agent" ? "worker" : "person"}
      name={name}
      tone={kind === "agent" ? "agent" : TONE_BY_COLOR[avatarColorForPrincipal(principalId)]}
      size="sm"
      {...(status === undefined ? {} : { status })}
    />
  );
}
