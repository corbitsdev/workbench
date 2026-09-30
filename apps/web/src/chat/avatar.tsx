import {
  Avatar,
  AvatarStack,
  type AvatarSize,
  type AvatarStackItem,
  type AvatarStatus,
  type AvatarTone,
} from "@corbits/react-ui";

import { agentInitials } from "@/chat/threads-api";
import "./avatar.css";

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

const WORKER_HUES = ["orange", "blue", "green"] as const;

// Hashed off the name: each bench deploys its own copy of a worker with a new
// principal id, so the id would recolor one worker per bench.
function workerHueClass(name: string): string {
  return `wb-av--${WORKER_HUES[hashPrincipal(name) % WORKER_HUES.length]}`;
}

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

export type CorbitAvatarSize = AvatarSize;
export type { AvatarStatus };

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
  return (
    <Avatar
      initials={agentInitials(name)}
      label={name}
      tone={tone}
      size={size}
      shape={kind === "person" ? "circle" : "square"}
      orbit={kind === "worker" && status === "working"}
      {...(status === undefined ? {} : { status })}
      className={[
        kind === "person" ? "wb-av wb-av--person" : `wb-av ${workerHueClass(name)}`,
        className,
      ]
        .filter((c) => c !== undefined)
        .join(" ")}
    />
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
