import {
  CheckCircle2,
  CircleDot,
  Database,
  FileText,
  KeyRound,
  Layers,
  MessageCircle,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Upload,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { BadgeTone } from "@workbench/ui";
import type { TimelineEntry, TimelineEntryKind } from "@workbench/client";

/**
 * Shared presentation metadata for the 13 timeline entry kinds: a neutral,
 * non-anthropomorphizing label, an icon, and a badge tone. Kept in one place so
 * every timeline surface renders a kind identically.
 *
 * NOTE: the tenant/actor activity feeds import this SAME module — do not
 * re-declare KIND_META or {@link relativeTime} there; extend them here instead.
 *
 * Tone policy (mirrors the Badge doc): `identity` for who/what an actor is
 * (session/message), `positive` for produced/accepted state
 * (artifact/approval), `neutral` for quiet metadata rows (including historical
 * event kinds like workflow_run/upload and permission-sensitive rows —
 * grant/credential — which are not themselves failures). `accent` (the single
 * orange action tone) is never used on a static timeline badge. A grant's tone
 * is refined per-row from its effect by {@link timelineEntryTone}.
 */
export const KIND_META: Record<
  TimelineEntryKind,
  { label: string; icon: LucideIcon; tone: BadgeTone }
> = {
  session: { label: "Session", icon: CircleDot, tone: "identity" },
  message: { label: "Message", icon: MessageSquare, tone: "identity" },
  inference_turn: { label: "Inference turn", icon: Sparkles, tone: "neutral" },
  tool_call: { label: "Tool call", icon: Wrench, tone: "neutral" },
  workflow_run: { label: "Workflow run", icon: Workflow, tone: "neutral" },
  artifact: { label: "Artifact", icon: FileText, tone: "positive" },
  artifact_version: {
    label: "Artifact version",
    icon: Layers,
    tone: "positive",
  },
  upload: { label: "Upload", icon: Upload, tone: "neutral" },
  memory: { label: "Memory", icon: Database, tone: "neutral" },
  approval: { label: "Approval", icon: CheckCircle2, tone: "positive" },
  output_feedback: {
    label: "Feedback",
    icon: MessageCircle,
    tone: "neutral",
  },
  grant: { label: "Grant", icon: ShieldCheck, tone: "neutral" },
  credential: { label: "Credential", icon: KeyRound, tone: "neutral" },
};

/**
 * Badge tone for a timeline row. Most kinds use their static {@link KIND_META}
 * tone; a grant is refined from its outcome so an ALLOWED grant reads as a
 * benign positive, not an alarming red. The effect is the trailing token of the
 * grant summary (`<resource> <action> <effect>`); only an explicit `deny` is
 * danger, an `allow` is positive, anything else (e.g. `ask`) stays neutral.
 */
export function timelineEntryTone(entry: TimelineEntry): BadgeTone {
  if (entry.kind === "grant") {
    const effect = (entry.summary ?? "").trim().split(/\s+/).pop() ?? "";
    if (effect === "deny") return "danger";
    if (effect === "allow") return "positive";
    return "neutral";
  }
  return KIND_META[entry.kind].tone;
}

/** Compact "just now / 5m ago / 3h ago / 2d ago" relative label. */
export function relativeTime(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
