import type { DisplayStepCharacter } from "../types";

/** Scope shown on list rows and inspectors. */
export type WorkflowScope = "personal" | "tenant";

/**
 * Status chip variants for live runs and schedules.
 * Maps to the dense list / inspector status vocabulary in the unified Workflows surface.
 */
export type WorkflowStatusTone =
  | "running"
  | "awaiting"
  | "done"
  | "paused"
  | "fail";

/** Live-run phase used by list rows and the live inspector shell. */
export type LiveRunPhase =
  | "running"
  | "awaiting"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowListItemKind = "run" | "schedule";

/** One dense list row (live run or schedule). */
export interface WorkflowListItem {
  id: string;
  itemKind: WorkflowListItemKind;
  /** Primary label (usually workflow kind label). */
  title: string;
  /** Secondary alias / origin tag under the title. */
  subtitle?: string;
  /** When column: origin for live, cadence for schedule. */
  when: string;
  scope: WorkflowScope;
  statusTone: WorkflowStatusTone;
  statusLabel: string;
  /** Next fire or elapsed mono text. */
  nextOrElapsed: string;
  /** Highlight next/elapsed when soon. */
  nextSoon?: boolean;
  /** Live rows that need attention get a subtle accent stripe. */
  needsYou?: boolean;
}

export type StepDisplayStatus = "pending" | "active" | "done" | "failed";

/** One step row in the live inspector step list. */
export interface StepListItem {
  id: string;
  name: string;
  status: StepDisplayStatus;
  meta?: string;
  /** Optional character from display-flow derivation. */
  character?: DisplayStepCharacter;
}

export type GateKind = "reviewList" | "choice" | "form" | "multiSelect";

/** Shell model for a pending gate block; payload body is a render prop. */
export interface GateShellModel {
  kind: GateKind;
  title: string;
  prompt?: string;
}

export interface KindPickerItem {
  id: string;
  label: string;
  description: string;
  /** Optional grouping key; omit when every item shares one category (nothing to distinguish). */
  category?: string;
  /** Optional grouping label shown on the card; omit along with `category`. */
  categoryLabel?: string;
  /** Already scheduled / installed badge. */
  alreadyOn?: boolean;
  /** Optional badge text when already on (e.g. "Mine 1 · Everyone 1"). */
  alreadyOnLabel?: string;
  kindSlug?: string;
}
