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
import type { TimelineEntryKind } from "@workbench/client";

/**
 * Shared presentation metadata for the 13 timeline entry kinds: a neutral,
 * non-anthropomorphizing label, an icon, and a badge tone. Kept in one place so
 * every timeline surface renders a kind identically.
 *
 * NOTE: PR #568 (CL-2526 RecentActivity feed) imports this SAME module — do not
 * re-declare KIND_META or {@link relativeTime} there; extend them here instead.
 *
 * Tone policy (mirrors the Badge doc): `identity` for who/what an actor is
 * (session/message), `accent` (the single orange action tone) only where an
 * action was initiated (workflow_run/upload), `positive` for produced/accepted
 * state (artifact/approval), `danger` for permission-sensitive rows whose
 * timeline is explicitly NOT an audit history (grant/credential), `neutral`
 * otherwise.
 */
export const KIND_META: Record<
  TimelineEntryKind,
  { label: string; icon: LucideIcon; tone: BadgeTone }
> = {
  session: { label: "Session", icon: CircleDot, tone: "identity" },
  message: { label: "Message", icon: MessageSquare, tone: "identity" },
  inference_turn: { label: "Inference turn", icon: Sparkles, tone: "neutral" },
  tool_call: { label: "Tool call", icon: Wrench, tone: "neutral" },
  workflow_run: { label: "Workflow run", icon: Workflow, tone: "accent" },
  artifact: { label: "Artifact", icon: FileText, tone: "positive" },
  artifact_version: {
    label: "Artifact version",
    icon: Layers,
    tone: "positive",
  },
  upload: { label: "Upload", icon: Upload, tone: "accent" },
  memory: { label: "Memory", icon: Database, tone: "neutral" },
  approval: { label: "Approval", icon: CheckCircle2, tone: "positive" },
  output_feedback: {
    label: "Feedback",
    icon: MessageCircle,
    tone: "neutral",
  },
  grant: { label: "Grant", icon: ShieldCheck, tone: "danger" },
  credential: { label: "Credential", icon: KeyRound, tone: "danger" },
};

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
