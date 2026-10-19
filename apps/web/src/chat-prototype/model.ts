// The conversation's data model: what a message is made of. Pure types,
// shared by the components and by the adapters that map real data onto them.

export type Participant = {
  readonly id: string;
  readonly kind: "person" | "agent";
  readonly name: string;
  /** One line under an agent's name, e.g. "Research · Exa, GitHub". */
  readonly role?: string;
};

export type TextPart = { readonly type: "text"; readonly text: string };

export type ReasoningPart = {
  readonly type: "reasoning";
  readonly text: string;
  /** Known once the thinking ends. */
  readonly durationMs?: number;
};

export type ToolState = "running" | "done" | "error";

export type ToolPart = {
  readonly type: "tool";
  readonly id: string;
  /** Raw tool identifier, shown in mono. */
  readonly name: string;
  /** Human phrasing of what the step did. */
  readonly label: string;
  readonly state: ToolState;
  readonly detail?: string;
  /** Calls with the same batch ran at the same time. */
  readonly batch?: string;
};

export type ApprovalDecision = "once" | "always" | "ask" | "deny";

export type ApprovalPart = {
  readonly type: "approval";
  readonly id: string;
  readonly tool: string;
  /** The platform's own account of what is being asked. */
  readonly summary: string;
  readonly scope: string;
  readonly decision: ApprovalDecision | null;
};

export type FilePart = {
  readonly type: "file";
  readonly name: string;
  readonly mediaType: string;
  readonly size: string;
  /** An image's preview, shown as a thumbnail. */
  readonly previewUrl?: string;
  /** The start of pasted text, shown on hover. */
  readonly excerpt?: string;
};

export type SourcesPart = {
  readonly type: "sources";
  readonly sources: readonly { readonly title: string; readonly url: string }[];
};

export type PlanStepStatus = "pending" | "active" | "done" | "skipped";

export type PlanPart = {
  readonly type: "plan";
  readonly id: string;
  readonly title: string;
  /** `proposed` waits for the person to start it; `started` is a proposal
   * that has handed off to a live run further down; `running` updates in
   * place. */
  readonly state: "proposed" | "started" | "running" | "done";
  readonly steps: readonly {
    readonly id: string;
    readonly label: string;
    readonly status: PlanStepStatus;
  }[];
};

export type ArtifactPart = {
  readonly type: "artifact";
  readonly artifactId: string;
  readonly version: number;
  /** A revision is announced in one line; only a new artifact earns a card. */
  readonly change: "created" | "updated";
  /** Still being written: the card shows progress, not a broken preview. */
  readonly pending?: boolean;
};

export type OfferKind = "skill" | "workflow" | "agent";

/** The worker proposing a capability. Nothing is installed until the
 * person says yes; `needs` says, in plain words, what it could then do. */
export type OfferPart = {
  readonly type: "offer";
  readonly id: string;
  readonly kind: OfferKind;
  readonly name: string;
  readonly summary: string;
  readonly needs: readonly string[];
  readonly state: "offered" | "installed" | "declined";
};

/** A service the worker needs connected before it can help. */
export type ConnectPart = {
  readonly type: "connect";
  readonly id: string;
  readonly service: string;
  /** Why connecting helps, in the worker's words. */
  readonly reason: string;
  readonly state: "needed" | "connected" | "skipped";
};

/** One generated image: the shape the AI SDK hands back (base64 and a
 * media type), or a URL once the image is stored. */
export type GeneratedImage = {
  readonly id: string;
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
  readonly alt?: string;
} & ({ readonly url: string } | { readonly base64: string });

/** Images an agent made: generating (with how many are coming and at what
 * size), done, or failed. */
export type ImagePart = {
  readonly type: "image";
  readonly id: string;
  readonly prompt: string;
  readonly state: "generating" | "done" | "error";
  readonly images: readonly GeneratedImage[];
  /** While generating: how many, and their shape, so the placeholders
   * hold the space the images will take. */
  readonly expected?: { readonly count: number; readonly width: number; readonly height: number };
  readonly model?: string;
};

export type ChatPart =
  | TextPart
  | ReasoningPart
  | ToolPart
  | ApprovalPart
  | FilePart
  | SourcesPart
  | PlanPart
  | ArtifactPart
  | OfferPart
  | ConnectPart
  | ImagePart;

export type MessageStatus = "sent" | "sending" | "failed" | "streaming";

export type Reaction = { readonly emoji: string; readonly count: number; readonly mine: boolean };

export type Feedback = "up" | "down";

/** What the server would send alongside a message that has replies. */
export type ThreadSummary = {
  readonly count: number;
  readonly lastAt: string;
};

export type ChatMessage = {
  readonly type: "message";
  readonly id: string;
  readonly authorId: string;
  readonly at: string;
  readonly parts: readonly ChatPart[];
  /** `sending`/`failed` are your own sends; `streaming` is an agent turn in progress. */
  readonly status: MessageStatus;
  /** Set on a reply: the message whose thread it belongs to. */
  readonly threadId?: string;
  readonly thread?: ThreadSummary;
  readonly reactions?: readonly Reaction[];
  readonly feedback?: Feedback;
  readonly pinned?: boolean;
  /** Posted by a scheduled run rather than in reply: the run's name. */
  readonly via?: string;
};

export type SystemEntry = {
  readonly type: "system";
  readonly id: string;
  readonly at: string;
  readonly text: string;
};

export type TimelineEntry = ChatMessage | SystemEntry;
