// Chat prototype. Everything it needs lives in this one file: the message
// model, mock data, a set of fully stateless components, and a playground
// that drives them. Components take data and callbacks only; the
// playground at the bottom is the single place state lives.
// Nothing in the live chat (`src/chat`, `pages/workbench-page.tsx`) imports
// this; it is reachable only at /prototype/chat in a dev build.
//
// Where work products live:
// - In the thread, a turn reads top to bottom: thinking, the plan, the tool
//   steps, then what it produced. A plan is a live checklist card; an
//   artifact is a compact card with a preview, and a later revision is a
//   one-line "Updated … to v2" rather than a second card.
// - Anything worth reading at length opens beside the thread in one side
//   panel: a document, a sheet, a file, or a thread's replies. The
//   conversation never scrolls away from under it.

import { reportError } from "@corbits/error-sink";
import { CsvTable, ThinkingLabel, ThinkingMark } from "@corbits/react-ui";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
} from "@corbits/react-ui/ui/menu";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { Streamdown } from "streamdown";
import "streamdown/styles.css";

import { BenchPill } from "@/bench/bench-pill";
// The live chat's own avatar and its row sizing (`chat-thread-avatar`), so a
// participant looks the same here as everywhere else in the app.
import { IdentityAvatar } from "@/chat/avatar";
import "@/chat/composer.css";
import "@/chat/thread.css";
// The live chat's own "Thinking… / Working on it…" indicator.
import "@/chat/working-label.css";
import "@/pages/new-workbench.css";
import {
  ArrowBendUpLeft,
  ArrowDown,
  ArrowUp,
  ArrowsOut,
  ArrowsIn,
  Bell,
  BellOff,
  Brain,
  AtSign,
  AudioLines,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  Check,
  CircleNotch,
  ArrowClockwise,
  ClockCounterClockwise,
  Copy,
  DotsThree,
  DownloadSimple,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  FlowArrow,
  Lightning,
  LinkSimple,
  ListChecks,
  Paperclip,
  Play,
  Plugs,
  Plus,
  PushPin,
  Repeat,
  Robot,
  Shield,
  Smiley,
  SquareSlash,
  Stack,
  Stop,
  Table,
  Trash,
  ThumbsDown,
  ThumbsUp,
  Warning,
  X,
} from "@/lib/icons";
import "./chat-prototype.css";

type Participant = {
  readonly id: string;
  readonly kind: "person" | "agent";
  readonly name: string;
  /** One line under an agent's name, e.g. "Research · Exa, GitHub". */
  readonly role?: string;
};

type TextPart = { readonly type: "text"; readonly text: string };

type ReasoningPart = {
  readonly type: "reasoning";
  readonly text: string;
  /** Known once the thinking ends. */
  readonly durationMs?: number;
};

type ToolState = "running" | "done" | "error";

type ToolPart = {
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

type ApprovalDecision = "once" | "always" | "ask" | "deny";

type ApprovalPart = {
  readonly type: "approval";
  readonly id: string;
  readonly tool: string;
  /** The platform's own account of what is being asked. */
  readonly summary: string;
  readonly scope: string;
  readonly decision: ApprovalDecision | null;
};

type FilePart = {
  readonly type: "file";
  readonly name: string;
  readonly mediaType: string;
  readonly size: string;
  /** An image's preview, shown as a thumbnail. */
  readonly previewUrl?: string;
  /** The start of pasted text, shown on hover. */
  readonly excerpt?: string;
};

type SourcesPart = {
  readonly type: "sources";
  readonly sources: readonly { readonly title: string; readonly url: string }[];
};

type PlanStepStatus = "pending" | "active" | "done" | "skipped";

type PlanPart = {
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

type ArtifactPart = {
  readonly type: "artifact";
  readonly artifactId: string;
  readonly version: number;
  /** A revision is announced in one line; only a new artifact earns a card. */
  readonly change: "created" | "updated";
  /** Still being written: the card shows progress, not a broken preview. */
  readonly pending?: boolean;
};

type OfferKind = "skill" | "workflow" | "agent";

/** The worker proposing a capability. Nothing is installed until the
 * person says yes; `needs` says, in plain words, what it could then do. */
type OfferPart = {
  readonly type: "offer";
  readonly id: string;
  readonly kind: OfferKind;
  readonly name: string;
  readonly summary: string;
  readonly needs: readonly string[];
  readonly state: "offered" | "installed" | "declined";
};

/** A service the worker needs connected before it can help. */
type ConnectPart = {
  readonly type: "connect";
  readonly id: string;
  readonly service: string;
  /** Why connecting helps, in the worker's words. */
  readonly reason: string;
  readonly state: "needed" | "connected" | "skipped";
};

/** One generated image: the shape the AI SDK hands back (base64 and a
 * media type), or a URL once the image is stored. */
type GeneratedImage = {
  readonly id: string;
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
  readonly alt?: string;
} & ({ readonly url: string } | { readonly base64: string });

/** Images an agent made: generating (with how many are coming and at what
 * size), done, or failed. */
type ImagePart = {
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

type ChatPart =
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

type MessageStatus = "sent" | "sending" | "failed" | "streaming";

type Reaction = { readonly emoji: string; readonly count: number; readonly mine: boolean };

type Feedback = "up" | "down";

/** What the server would send alongside a message that has replies. */
type ThreadSummary = {
  readonly count: number;
  readonly lastAt: string;
};

type ChatMessage = {
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

type SystemEntry = {
  readonly type: "system";
  readonly id: string;
  readonly at: string;
  readonly text: string;
};

type TimelineEntry = ChatMessage | SystemEntry;

type ArtifactKind = "doc" | "sheet" | "code";

type ArtifactVersion = {
  readonly version: number;
  readonly at: string;
  readonly authorId: string;
  readonly content: string;
  /** What changed in this revision, in the author's words. */
  readonly note: string;
};

type Artifact = {
  readonly id: string;
  readonly title: string;
  readonly kind: ArtifactKind;
  readonly language?: string;
  readonly versions: readonly ArtifactVersion[];
};

type ComposerStatus = "ready" | "submitting" | "streaming";

/** Something the composer completes and highlights: a worker to mention
 * or a command to run. */
type Suggestion = {
  readonly id: string;
  readonly kind: "mention" | "command";
  /** Exactly as it lands in the text: "@Ada", "/brief". */
  readonly token: string;
  /** Shown beside it in the list, and on hover once it is in the text. */
  readonly detail?: string;
};

/** What a composer offers. Each surface states every one, so switching a
 * capability off is a one-word change where the composer is used. */
type ComposerCapabilities = {
  readonly files: boolean;
  readonly voice: boolean;
  readonly model: boolean;
  readonly mode: boolean;
  readonly mentions: boolean;
  readonly commands: boolean;
  /** The line of small print under the box. */
  readonly note: boolean;
};

type ModelOption = {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  /** What the trigger shows, e.g. "Sonnet 5.5". */
  readonly short: string;
  readonly detail: string;
  /** Whether the model takes a reasoning level at all. */
  readonly reasons: boolean;
};

type ReasoningLevel = { readonly id: string; readonly label: string; readonly detail: string };

type ModelChoice = { readonly modelId: string; readonly reasoningId: string };

/** A way of working. Its strings are data, so a bench can name its own. */
type ModeOption = {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  /** Replaces the composer's placeholder while this mode is on. */
  readonly placeholder?: string;
};

/** A file waiting in the composer: dropped, pasted or picked. */
type Attachment = {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: string;
  readonly previewUrl?: string;
  readonly excerpt?: string;
  /** Name, size and last change: how a second copy of the same file is
   * recognised. Pasted text has none. */
  readonly fingerprint?: string;
};

/** What the next message is about, shown above the input. */
type ComposerContext = { readonly label: string; readonly detail: string };

type PanelState =
  | { readonly kind: "thread"; readonly messageId: string }
  | { readonly kind: "artifact"; readonly artifactId: string; readonly version: number };

function timeLabel(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function dayLabel(at: string): string {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

function relativeTime(at: string): string {
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return hours < 48
    ? "yesterday"
    : new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function messageText(message: ChatMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
}

type PartGroup =
  | {
      readonly kind: "part";
      readonly key: string;
      readonly part: Exclude<ChatPart, ToolPart | FilePart | ReasoningPart>;
    }
  | { readonly kind: "activity"; readonly key: string; readonly items: readonly ActivityItem[] }
  | { readonly kind: "files"; readonly key: string; readonly files: readonly FilePart[] };

/** A run of thinking and tool calls, however interleaved, folds into one
 * activity block; consecutive files sit together as one gallery. */
function groupParts(parts: readonly ChatPart[]): readonly PartGroup[] {
  const groups: PartGroup[] = [];
  parts.forEach((part, index) => {
    const last = groups.at(-1);
    if (part.type === "file") {
      if (last?.kind === "files") {
        groups[groups.length - 1] = { ...last, files: [...last.files, part] };
      } else {
        groups.push({ kind: "files", key: `files-${index}`, files: [part] });
      }
      return;
    }
    if (part.type === "tool" || part.type === "reasoning") {
      if (last?.kind === "activity") {
        groups[groups.length - 1] = { ...last, items: [...last.items, part] };
      } else {
        groups.push({ kind: "activity", key: `activity-${index}`, items: [part] });
      }
      return;
    }
    groups.push({ kind: "part", key: `${part.type}-${index}`, part });
  });
  return groups;
}

function artifactVersion(artifact: Artifact, version: number): ArtifactVersion | undefined {
  return artifact.versions.find((candidate) => candidate.version === version);
}

function latestVersion(artifact: Artifact): number {
  return artifact.versions.at(-1)?.version ?? 1;
}

function csvRows(content: string): readonly (readonly string[])[] {
  return content
    .trim()
    .split("\n")
    .map((line) => line.split(",").map((cell) => cell.trim()));
}

/** Markdown reduced to the words a preview shows. */
function plainExcerpt(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !line.startsWith("#") && line.trim() !== "")
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))
    .join(" ")
    .replace(/[*_`>]/g, "");
}

const KIND_LABEL: Record<ArtifactKind, string> = { doc: "Document", sheet: "Sheet", code: "Code" };

function artifactMeta(artifact: Artifact, version: ArtifactVersion): string {
  const { content } = version;
  if (artifact.kind === "sheet") {
    const rows = csvRows(content);
    return `${rows.length - 1} rows · ${rows[0]?.length ?? 0} columns`;
  }
  if (artifact.kind === "code") {
    const lines = `${content.split("\n").length} lines`;
    return artifact.language === undefined ? lines : `${lines} · ${artifact.language}`;
  }
  return `${content.split(/\s+/).filter(Boolean).length} words`;
}

function KindIcon({ kind }: { readonly kind: ArtifactKind }) {
  if (kind === "sheet") return <Table aria-hidden="true" />;
  if (kind === "code") return <FileCode aria-hidden="true" />;
  return <FileText aria-hidden="true" />;
}

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  once: "Allowed once",
  always: "Always allowed in this workbench",
  ask: "Allowed — will ask every time",
  deny: "Denied",
};

const REACTIONS = ["👍", "🎉", "👀", "✅", "❤️", "😄"];

const WORKING_VERBS = ["Thinking…", "Working on it…"];

/** Under the last message while an agent has a turn open: the words
 * lined up with message text, with the live chat's mark beside them when
 * `mark` is set. */
function Working({ mark = false }: { readonly mark?: boolean }) {
  return (
    <div className="chat-thread-working cp-working">
      {mark ? <ThinkingMark variant="silk" className="chat-thread-working-mark" /> : null}
      <ThinkingLabel verbs={WORKING_VERBS} intervalMs={3000} />
    </div>
  );
}

function Shimmer({ children }: { readonly children: ReactNode }) {
  return <span className="cp-shimmer">{children}</span>;
}

function DayDivider({ at }: { readonly at: string }) {
  return (
    <div className="cp-day" role="separator">
      <span>{dayLabel(at)}</span>
    </div>
  );
}

function SystemLine({ entry }: { readonly entry: SystemEntry }) {
  return <p className="cp-system">{entry.text}</p>;
}

/** Word-by-word fade for streamed text; none under reduced motion. */
const STREAM_ANIMATION = { animation: "fadeIn", duration: 160, sep: "word" } as const;

/** Markdown through Streamdown. While streaming it renders unfinished
 * syntax (an open `**`, a half-written table or fence) as what it will
 * become, so text never flashes raw markup. Output is sanitized. Its own
 * Tailwind look is unused here: every element carries a `data-streamdown`
 * hook, and `.cp-md` styles those with our tokens. Copy stays on code and
 * tables; fullscreen, download and the link-confirm dialog are off. */
function Prose({
  markdown,
  streaming = false,
}: {
  readonly markdown: string;
  readonly streaming?: boolean;
}) {
  const still = useReducedMotion();
  return (
    <Streamdown
      className="cp-md"
      mode={streaming ? "streaming" : "static"}
      isAnimating={streaming}
      animated={streaming && !still ? STREAM_ANIMATION : false}
      parseIncompleteMarkdown
      controls={{
        code: { copy: true, download: false },
        table: { copy: true, download: false, fullscreen: false },
        mermaid: false,
      }}
      linkSafety={{ enabled: false }}
    >
      {markdown}
    </Streamdown>
  );
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return reduced;
}

/** Answers longer than this (about a thousand words) can fold. */
const LONG_ANSWER_CHARS = 6_000;

/** An answer's text. A very long one folds: the newest answer starts open
 * with a "Collapse" control that stays in reach while it is read; older
 * ones start folded to their opening, with "Show full answer". */
function TextBlock({
  part,
  streaming,
  latest,
}: {
  readonly part: TextPart;
  readonly streaming: boolean;
  readonly latest: boolean;
}) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  // Folding a long answer from deep inside it would leave the reader in
  // whatever follows; once folded, the control is brought back into view
  // before the frame is drawn.
  const folding = useRef(false);
  useLayoutEffect(() => {
    if (!folding.current || choice !== false) return;
    folding.current = false;
    toggleRef.current?.scrollIntoView({ block: "nearest" });
  }, [choice]);
  const long = !streaming && part.text.length > LONG_ANSWER_CHARS;
  if (!long) {
    return (
      <div className={streaming ? "cp-text cp-text--streaming" : "cp-text"}>
        <Prose markdown={part.text} streaming={streaming} />
      </div>
    );
  }
  const open = choice ?? latest;
  const words = part.text.split(/\s+/).length.toLocaleString();
  return (
    <div className="cp-text cp-text--long" data-folded={open ? undefined : "true"}>
      <Prose markdown={part.text} />
      <div className="cp-text-fold">
        <button
          ref={toggleRef}
          type="button"
          className="cp-text-toggle"
          aria-expanded={open}
          onClick={() => {
            folding.current = open;
            setChoice(!open);
          }}
        >
          {open ? (
            <>
              <CaretUp aria-hidden="true" /> Collapse
            </>
          ) : (
            <>
              <CaretDown aria-hidden="true" /> Show full answer · {words} words
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function StepIcon({ state }: { readonly state: ToolState }) {
  if (state === "running") return <CircleNotch className="cp-spin" aria-label="Running" />;
  if (state === "error") return <Warning className="cp-step-error" aria-label="Failed" />;
  return <Check className="cp-step-done" aria-label="Done" />;
}

type ActivityItem = ReasoningPart | ToolPart;

/** One row in an opened activity block: a thought, a single call, or a
 * batch of calls that ran at the same time. */
type ActivityEntry =
  | { readonly kind: "thought"; readonly key: string; readonly part: ReasoningPart }
  | { readonly kind: "tool"; readonly key: string; readonly part: ToolPart }
  | { readonly kind: "batch"; readonly key: string; readonly tools: readonly ToolPart[] };

/** Calls sharing a `batch` ran together, so they read as one row. */
function activityEntries(items: readonly ActivityItem[]): readonly ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  items.forEach((item, index) => {
    if (item.type === "reasoning") {
      entries.push({ kind: "thought", key: `thought-${index}`, part: item });
      return;
    }
    const last = entries.at(-1);
    if (item.batch !== undefined && last?.kind === "batch" && last.tools[0]?.batch === item.batch) {
      entries[entries.length - 1] = { ...last, tools: [...last.tools, item] };
    } else if (item.batch !== undefined) {
      entries.push({ kind: "batch", key: `batch-${item.batch}-${index}`, tools: [item] });
    } else {
      entries.push({ kind: "tool", key: item.id, part: item });
    }
  });
  return entries;
}

function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function thoughtLabel(part: ReasoningPart): string {
  return part.durationMs === undefined ? "Thought" : `Thought for ${duration(part.durationMs)}`;
}

/** What a finished block says when folded: how long it thought and how
 * many calls it made (failures are counted beside it). */
function activitySummary(items: readonly ActivityItem[]): string {
  const thoughts = items.filter((item): item is ReasoningPart => item.type === "reasoning");
  const tools = items.filter((item): item is ToolPart => item.type === "tool");
  const [first] = thoughts;
  const thinking =
    thoughts.length > 1
      ? `${thoughts.length} thoughts`
      : first === undefined
        ? null
        : thoughtLabel(first);
  const batches = new Set(tools.flatMap((tool) => (tool.batch === undefined ? [] : [tool.batch])));
  const allAtOnce = batches.size === 1 && tools.every((tool) => tool.batch !== undefined);
  if (thinking === null && allAtOnce) return `Ran ${tools.length} at once`;
  const steps =
    tools.length === 0
      ? null
      : batches.size === 0
        ? count(tools.length, "step", "steps")
        : `${count(tools.length, "step", "steps")} (${count(batches.size, "batch", "batches")} at once)`;
  const head = [thinking, steps].filter((piece) => piece !== null).join(" · ");
  return head === "" ? "Worked" : thinking === null ? `Worked through ${head}` : head;
}

/** While the block works: what it's doing right now, as one line. */
function activityNow(items: readonly ActivityItem[]): string {
  const running = items.filter(
    (item): item is ToolPart => item.type === "tool" && item.state === "running",
  );
  if (running.length > 1) return `Running ${running.length} at once`;
  const only = running[0];
  if (only !== undefined) return only.label;
  return items.at(-1)?.type === "reasoning" ? "Thinking" : "Working";
}

/** Long lists open on their latest entries; older ones wait behind a button. */
const ACTIVITY_SHOWN = 10;

/** A stretch of an agent's work (thinking and tool calls, however many and
 * however interleaved) as one block. Folded by default, live or done:
 * while working it shows what's happening now in one line and, beneath, a
 * small fixed window onto the newest thinking or the calls running, so a
 * long stream never pushes the conversation around. Opened, it lists every
 * thought and call in order, parallel calls together, newest last; a long
 * list shows its last few with the rest behind "Show earlier". Nothing in
 * a folded block is in the page. A person's open/close choice sticks. */
function ActivityBlock({
  items,
  live,
}: {
  readonly items: readonly ActivityItem[];
  readonly live: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const tools = items.filter((item): item is ToolPart => item.type === "tool");
  const failed = tools.filter((tool) => tool.state === "error").length;
  const running = tools.filter((tool) => tool.state === "running");
  const latest = items.at(-1);
  const grouped = open ? activityEntries(items) : [];
  // A block that is one batch already says so in its header; list the calls.
  const only = grouped.length === 1 ? grouped[0] : undefined;
  const entries: readonly ActivityEntry[] =
    only?.kind === "batch"
      ? only.tools.map((tool) => ({ kind: "tool", key: tool.id, part: tool }))
      : grouped;
  const hidden = all ? 0 : Math.max(0, entries.length - ACTIVITY_SHOWN);
  return (
    <div className="cp-activity" data-live={live ? "true" : undefined}>
      <button
        type="button"
        className="cp-activity-head"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {live ? <Shimmer>{activityNow(items)}…</Shimmer> : <span>{activitySummary(items)}</span>}
        {live && tools.length > 0 ? (
          <span className="cp-activity-count">{count(tools.length, "step", "steps")}</span>
        ) : null}
        {failed > 0 ? <span className="cp-steps-failed">· {failed} failed</span> : null}
        <CaretDown className="cp-fold-caret" aria-hidden="true" />
      </button>
      {live && !open ? (
        running.length > 0 ? (
          <ul className="cp-activity-peek cp-activity-running" aria-live="polite">
            {running.slice(0, 3).map((tool) => (
              <li key={tool.id}>
                <CircleNotch className="cp-spin" aria-hidden="true" /> {tool.label}
              </li>
            ))}
            {running.length > 3 ? <li>+{running.length - 3} more</li> : null}
          </ul>
        ) : latest?.type === "reasoning" ? (
          // A window onto the newest thinking: the latest lines, fading out
          // at the top, never taller than a few lines.
          <div className="cp-activity-peek cp-activity-thought" aria-hidden="true">
            <p>{latest.text.slice(-600)}</p>
          </div>
        ) : null
      ) : null}
      {open ? (
        <ol className="cp-activity-list">
          {hidden > 0 ? (
            <li>
              <button type="button" className="cp-activity-more" onClick={() => setAll(true)}>
                Show {count(hidden, "earlier entry", "earlier entries")}
              </button>
            </li>
          ) : null}
          {entries.slice(hidden).map((entry) => (
            <li key={entry.key} className="cp-activity-entry" data-kind={entry.kind}>
              {entry.kind === "thought" ? (
                <ThoughtEntry part={entry.part} />
              ) : entry.kind === "tool" ? (
                <ToolEntry part={entry.part} />
              ) : (
                <BatchEntry tools={entry.tools} />
              )}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function ToolEntry({ part }: { readonly part: ToolPart }) {
  return (
    <div className="cp-step" data-state={part.state}>
      <StepIcon state={part.state} />
      <div>
        <div>
          {part.label} <code>{part.name}</code>
        </div>
        {part.detail === undefined ? null : <div className="cp-step-detail">{part.detail}</div>}
      </div>
    </div>
  );
}

/** Calls that ran at the same time: one row saying so, the calls beneath. */
function BatchEntry({ tools }: { readonly tools: readonly ToolPart[] }) {
  const running = tools.filter((tool) => tool.state === "running").length;
  const failed = tools.filter((tool) => tool.state === "error").length;
  return (
    <div className="cp-batch">
      <div className="cp-batch-head">
        <Stack aria-hidden="true" />
        {running > 0
          ? `Running ${tools.length} at once · ${tools.length - running} done`
          : `Ran ${tools.length} at once`}
        {failed > 0 ? <span className="cp-steps-failed"> · {failed} failed</span> : null}
      </div>
      <ol className="cp-batch-list">
        {tools.map((tool) => (
          <li key={tool.id}>
            <ToolEntry part={tool} />
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A thought as one line; opened, all of it in a box that scrolls rather
 * than grows. */
function ThoughtEntry({ part }: { readonly part: ReasoningPart }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cp-thought">
      <button
        type="button"
        className="cp-thought-head"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Brain aria-hidden="true" />
        <span className="cp-thought-label">{thoughtLabel(part)}</span>
        {open ? null : <span className="cp-thought-preview">{part.text}</span>}
      </button>
      {open ? <div className="cp-thought-body">{part.text}</div> : null}
    </div>
  );
}

function ApprovalCard({
  part,
  onDecide,
}: {
  readonly part: ApprovalPart;
  readonly onDecide: (approvalId: string, decision: ApprovalDecision) => void;
}) {
  if (part.decision !== null) {
    return (
      <div className="cp-approval-resolved" data-decision={part.decision}>
        {part.decision === "deny" ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
        <span>
          {DECISION_LABEL[part.decision]} · <code>{part.tool}</code>
        </span>
      </div>
    );
  }
  const decide = (decision: ApprovalDecision) => () => onDecide(part.id, decision);
  return (
    <section className="cp-card cp-approval" aria-label="Approval needed">
      <header className="cp-approval-head">
        <Shield aria-hidden="true" />
        <span>Needs your approval</span>
        <code>{part.tool}</code>
      </header>
      <p className="cp-approval-summary">{part.summary}</p>
      <p className="cp-approval-scope">{part.scope}</p>
      <div className="cp-approval-actions">
        <button type="button" className="cp-btn cp-btn--primary" onClick={decide("once")}>
          Allow once
        </button>
        <button type="button" className="cp-btn" onClick={decide("always")}>
          Always allow
        </button>
        <button type="button" className="cp-btn" onClick={decide("ask")}>
          Ask every time
        </button>
        <button type="button" className="cp-btn cp-btn--deny" onClick={decide("deny")}>
          Deny
        </button>
      </div>
    </section>
  );
}

type MediaKind = "image" | "video" | "audio" | "pdf" | "code" | "text" | "archive" | "file";

/** Source files, by extension. Browsers type these unreliably: most come
 * through untyped, and `.ts` arrives as `video/mp2t` (a video stream). */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "html",
  "css",
  "scss",
  "less",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "xml",
  "graphql",
  "proto",
  "lua",
  "r",
  "dart",
  "vue",
  "svelte",
  "ex",
  "exs",
  "erl",
  "clj",
  "scala",
  "tf",
  "ini",
  "env",
  "lock",
]);

/** Extensionless files that are code all the same. */
const CODE_NAMES: ReadonlySet<string> = new Set(["dockerfile", "makefile", "procfile", "gemfile"]);

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(["md", "mdx", "txt", "csv", "tsv", "log"]);

const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  "zip",
  "gz",
  "tgz",
  "tar",
  "rar",
  "7z",
  "bz2",
  "xz",
  "dmg",
  "iso",
]);

function extensionKey(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** What a file is, for how it previews. The name decides first for code,
 * text and archives, whose media types browsers get wrong or leave blank;
 * the media type decides the rest. */
function mediaKindOf(mediaType: string, name: string): MediaKind {
  const extension = extensionKey(name);
  if (CODE_EXTENSIONS.has(extension) || CODE_NAMES.has(name.toLowerCase())) return "code";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  if (ARCHIVE_EXTENSIONS.has(extension)) return "archive";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType.startsWith("text/") || mediaType === "application/json") return "text";
  return "file";
}

/** Whether a file's contents are worth reading for a preview. */
function readsAsText(kind: MediaKind): boolean {
  return kind === "code" || kind === "text";
}

/** "PDF", "CSV": the type, for a file with no picture to show. */
function extensionOf(name: string): string {
  const extension = extensionKey(name);
  if (extension === "") {
    return CODE_NAMES.has(name.toLowerCase()) ? name.slice(0, 4).toUpperCase() : "FILE";
  }
  return extension.slice(0, 4).toUpperCase();
}

function MediaIcon({ kind }: { readonly kind: MediaKind }) {
  switch (kind) {
    case "image":
      return <FileImage aria-hidden="true" />;
    case "video":
      return <FileVideo aria-hidden="true" />;
    case "audio":
      return <FileAudio aria-hidden="true" />;
    case "code":
      return <FileCode aria-hidden="true" />;
    case "archive":
      return <FileArchive aria-hidden="true" />;
    case "pdf":
    case "text":
      return <FileText aria-hidden="true" />;
    case "file":
      return <Paperclip aria-hidden="true" />;
  }
}

/** What the viewer can show full size: a picture, a video, a PDF, or text. */
type ViewedMedia =
  | {
      readonly kind: "image" | "video" | "pdf";
      readonly src: string;
      readonly name: string;
      readonly size: string;
    }
  | { readonly kind: "text"; readonly text: string; readonly name: string; readonly size: string };

/** How a file opens in the viewer, or `null` when it can't (an archive, a
 * spreadsheet): those open in the browser instead. Audio plays in place. */
function viewableOf(file: FilePart): ViewedMedia | null {
  const kind = mediaKindOf(file.mediaType, file.name);
  if ((kind === "image" || kind === "video" || kind === "pdf") && file.previewUrl !== undefined) {
    return { kind, src: file.previewUrl, name: file.name, size: file.size };
  }
  if (file.excerpt !== undefined) {
    return { kind: "text", text: file.excerpt, name: file.name, size: file.size };
  }
  return null;
}

/** One file in a message as a thumbnail tile: the picture or a video's
 * first frame, a pasted text's opening lines, or for anything else its
 * type, name and size. With `onOpen` the tile is a button. */
function FileTile({ file, onOpen }: { readonly file: FilePart; readonly onOpen?: () => void }) {
  const kind = mediaKindOf(file.mediaType, file.name);
  const label = `${file.name}, ${file.size}`;
  if (kind === "audio" && file.previewUrl !== undefined) {
    // Audio plays where it is: the tile carries its own player.
    return (
      <span className="cp-tile-file" data-kind="audio">
        <span className="cp-tile-type">
          <MediaIcon kind="audio" />
          {extensionOf(file.name)}
        </span>
        <span className="cp-tile-name">{file.name}</span>
        <audio src={file.previewUrl} controls preload="metadata" aria-label={label} />
      </span>
    );
  }
  let face: ReactNode;
  if (kind === "image" && file.previewUrl !== undefined) {
    face = <img src={file.previewUrl} alt="" loading="lazy" />;
  } else if (kind === "video" && file.previewUrl !== undefined) {
    face = (
      <>
        <video src={file.previewUrl} muted playsInline preload="metadata" />
        <span className="cp-tile-play" aria-hidden="true">
          <Play />
        </span>
      </>
    );
  } else {
    face = (
      <span className="cp-tile-doc">
        <span className="cp-tile-type">
          <MediaIcon kind={kind} />
          {file.excerpt !== undefined && kind !== "code" ? "TEXT" : extensionOf(file.name)}
        </span>
        {file.excerpt === undefined ? null : (
          <span className="cp-tile-excerpt" aria-hidden="true">
            {file.excerpt}
          </span>
        )}
        <span className="cp-tile-name">{file.name}</span>
        <span className="cp-tile-size">{file.size}</span>
      </span>
    );
  }
  if (onOpen === undefined) {
    return (
      <span className="cp-tile-file" data-kind={kind} role="img" aria-label={label}>
        {face}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="cp-tile-file"
      data-kind={kind}
      aria-label={`Open ${label}`}
      onClick={onOpen}
    >
      {face}
    </button>
  );
}

/** A message's files as a row of thumbnails. A click hands the whole set
 * to `onOpenFile`, so a viewer can step between them. */
function MessageFiles({
  files,
  onOpenFile,
}: {
  readonly files: readonly FilePart[];
  readonly onOpenFile?: (files: readonly FilePart[], index: number) => void;
}) {
  // A big batch shows its first few and how many more, until asked.
  const [showAll, setShowAll] = useState(false);
  const folded = !showAll && files.length > MESSAGE_FILES_SHOWN;
  const shown = folded ? files.slice(0, MESSAGE_FILES_SHOWN - 1) : files;
  return (
    <div className="cp-msg-files">
      {shown.map((file, index) => (
        <FileTile
          key={`${index}-${file.name}`}
          file={file}
          {...(onOpenFile === undefined ? {} : { onOpen: () => onOpenFile(files, index) })}
        />
      ))}
      {folded ? (
        <button
          type="button"
          className="cp-tile-file cp-tile-more"
          aria-label={`Show all ${files.length} files`}
          onClick={() => setShowAll(true)}
        >
          +{files.length - shown.length}
        </button>
      ) : null}
    </div>
  );
}

function imageSrc(image: GeneratedImage): string {
  return "url" in image ? image.url : `data:${image.mediaType};base64,${image.base64}`;
}

/** The clipboard takes PNG everywhere and little else, so whatever the
 * image's own type, it is redrawn as a PNG first. */
async function imageAsPNG(src: string): Promise<Blob> {
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d")?.drawImage(image, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) =>
      blob === null ? reject(new Error("PNG encode failed")) : resolve(blob),
    );
  });
}

/** "cover-for-the-q3-2.png": the prompt's first words, then which image. */
function imageFileName(part: ImagePart, index: number, image: GeneratedImage): string {
  const extension = image.mediaType.split("/")[1]?.replace("svg+xml", "svg") ?? "png";
  const slug = part.prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 4)
    .join("-");
  return `${slug === "" ? "image" : slug}-${index + 1}.${extension}`;
}

/** Where an image will land while it's made: the exact space it takes. */
function PendingTile({ width, height }: { readonly width: number; readonly height: number }) {
  return (
    <div
      className="cp-gen-tile cp-gen-pending"
      style={{ aspectRatio: `${width} / ${height}` }}
      aria-hidden="true"
    >
      <span className="cp-gen-glow" />
      <span className="cp-gen-size">
        {width} × {height}
      </span>
    </div>
  );
}

/** One finished image: the picture once loaded (blurring in, never
 * popping), and on hover Download, Copy and Open. A click opens it full
 * size. */
function GeneratedTile({
  image,
  name,
  onOpen,
}: {
  readonly image: GeneratedImage;
  readonly name: string;
  readonly onOpen: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const src = imageSrc(image);
  const { width, height } = image;
  const copy = () => {
    imageAsPNG(src)
      .then((png) => navigator.clipboard.write([new ClipboardItem({ "image/png": png })]))
      .then(() => {
        setCopied(true);
        clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch((cause: unknown) => {
        reportError(cause, { operation: "chat_prototype_copy_image" });
      });
  };
  return (
    <figure
      className="cp-gen-tile"
      style={{ aspectRatio: `${width} / ${height}` }}
      data-loaded={loaded ? "true" : undefined}
    >
      <button
        type="button"
        className="cp-gen-open"
        aria-label={`Open ${image.alt ?? name}`}
        onClick={onOpen}
      >
        <img
          src={src}
          alt={image.alt ?? ""}
          width={width}
          height={height}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
        />
      </button>
      <span className="cp-gen-actions">
        <a
          className="cp-gen-action cp-tip"
          data-tip="Download"
          aria-label="Download"
          href={src}
          download={name}
        >
          <DownloadSimple aria-hidden="true" />
        </a>
        <button
          type="button"
          className="cp-gen-action cp-tip"
          data-tip={copied ? "Copied" : "Copy"}
          aria-label="Copy image"
          onClick={copy}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="cp-gen-action cp-tip"
          data-tip="Open"
          aria-label="Open full size"
          onClick={onOpen}
        >
          <ArrowsOut aria-hidden="true" />
        </button>
      </span>
    </figure>
  );
}

/** Images an agent made. While generating, placeholders hold the exact
 * space the images will take (so nothing jumps when they land), under a
 * shimmering "Generating"; done, one image shows large, two side by side,
 * more in a grid; failed, a quiet line with Retry. The prompt sits beneath
 * as the caption. */
function ImageOutput({
  part,
  onOpen,
  onRetry,
}: {
  readonly part: ImagePart;
  readonly onOpen: (files: readonly FilePart[], index: number) => void;
  readonly onRetry: (partId: string) => void;
}) {
  if (part.state === "error") {
    return (
      <div className="cp-gen-error" role="status">
        <Warning aria-hidden="true" />
        <span>Couldn't make this image.</span>
        <button type="button" className="cp-btn" onClick={() => onRetry(part.id)}>
          <ArrowClockwise aria-hidden="true" /> Try again
        </button>
      </div>
    );
  }
  const generating = part.state === "generating";
  const slots = generating ? (part.expected?.count ?? 1) : part.images.length;
  const files = part.images.map((image, index): FilePart => ({
    type: "file",
    name: imageFileName(part, index, image),
    mediaType: image.mediaType,
    size: `${image.width} × ${image.height}`,
    previewUrl: imageSrc(image),
  }));
  return (
    <div
      className="cp-gen"
      data-count={Math.min(slots, 4)}
      // One image shows large, but never taller than about 520px: a tall
      // one narrows instead of becoming a column.
      style={
        slots === 1
          ? {
              maxWidth: Math.min(
                512,
                Math.round(
                  (520 * (part.images[0]?.width ?? part.expected?.width ?? 1)) /
                    (part.images[0]?.height ?? part.expected?.height ?? 1),
                ),
              ),
            }
          : undefined
      }
    >
      {generating ? (
        <Shimmer>Generating {slots === 1 ? "image" : `${slots} images`}…</Shimmer>
      ) : null}
      <div className="cp-gen-grid">
        {Array.from({ length: slots }, (_, index) => {
          const image = generating ? undefined : part.images[index];
          return image === undefined ? (
            <PendingTile
              key={`pending-${index}`}
              width={part.expected?.width ?? 1024}
              height={part.expected?.height ?? 1024}
            />
          ) : (
            <GeneratedTile
              key={image.id}
              image={image}
              name={imageFileName(part, index, image)}
              onOpen={() => onOpen(files, index)}
            />
          );
        })}
      </div>
      <p className="cp-gen-caption">
        <span>{part.prompt}</span>
        {part.model === undefined ? null : <span className="cp-gen-model">{part.model}</span>}
      </p>
    </div>
  );
}

function SourcesList({ part }: { readonly part: SourcesPart }) {
  return (
    <ul className="cp-sources" aria-label="Sources">
      {part.sources.map((source, index) => (
        <li key={`${index}-${source.url}`}>
          <a href={source.url} target="_blank" rel="noopener noreferrer">
            <span className="cp-source-index">{index + 1}</span>
            <LinkSimple aria-hidden="true" />
            <span>{source.title}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function PlanMarker({ status }: { readonly status: PlanStepStatus }) {
  return (
    <span className="cp-plan-marker" data-status={status} aria-hidden="true">
      {status === "done" ? <Check /> : null}
    </span>
  );
}

const STEP_STATUS_LABEL: Record<PlanStepStatus, string> = {
  pending: "Not started",
  active: "In progress",
  done: "Done",
  skipped: "Skipped",
};

/** A live checklist. It updates in place while the agent works, folds to a
 * one-line summary once done, and waits for Start when only proposed. */
function PlanCard({
  part,
  startable,
  onStart,
}: {
  readonly part: PlanPart;
  /** False while a turn is already running: one run at a time. */
  readonly startable: boolean;
  readonly onStart: () => void;
}) {
  if (part.state === "started") {
    // The live run below carries the checklist; the proposal steps aside.
    return (
      <p className="cp-plan-started">
        <ListChecks aria-hidden="true" />
        <span>
          Started <b>{part.title}</b> · {part.steps.length} steps
        </span>
        <ArrowDown aria-hidden="true" />
      </p>
    );
  }
  const done = part.steps.filter((step) => step.status === "done").length;
  const total = part.steps.length;
  const steps = (
    <ol className="cp-plan-steps">
      {part.steps.map((step) => (
        <li key={step.id} data-status={step.status}>
          <PlanMarker status={step.status} />
          <span className="cp-plan-label">
            {step.status === "active" ? <Shimmer>{step.label}</Shimmer> : step.label}
          </span>
          <span className="cp-visually-hidden"> — {STEP_STATUS_LABEL[step.status]}</span>
        </li>
      ))}
    </ol>
  );
  return (
    <section className="cp-card cp-plan" data-state={part.state} aria-label={`Plan: ${part.title}`}>
      <header className="cp-plan-head">
        <span className="cp-tile">
          <ListChecks aria-hidden="true" />
        </span>
        <div className="cp-plan-title">
          <span className="cp-eyebrow">
            {part.state === "proposed"
              ? "Proposed plan"
              : part.state === "done"
                ? "Plan complete"
                : "Plan"}
          </span>
          <b>{part.title}</b>
        </div>
        {part.state === "proposed" ? null : (
          <div className="cp-plan-progress" aria-label={`${done} of ${total} steps done`}>
            <span>
              {done} of {total}
            </span>
            <span className="cp-meter">
              <span style={{ width: `${(done / Math.max(total, 1)) * 100}%` }} />
            </span>
          </div>
        )}
      </header>
      {part.state === "done" ? (
        <details className="cp-fold cp-plan-fold">
          <summary>
            <span>Show {total} steps</span>
            <CaretDown className="cp-fold-caret" aria-hidden="true" />
          </summary>
          {steps}
        </details>
      ) : (
        steps
      )}
      {part.state === "proposed" ? (
        <footer className="cp-plan-actions">
          <button
            type="button"
            className="cp-btn cp-btn--primary"
            disabled={!startable}
            onClick={onStart}
          >
            Start
          </button>
          <span className="cp-plan-hint">or reply to change it</span>
        </footer>
      ) : null}
    </section>
  );
}

function ArtifactPreview({
  artifact,
  version,
}: {
  readonly artifact: Artifact;
  readonly version: ArtifactVersion;
}) {
  if (artifact.kind === "sheet") {
    const [head = [], ...rows] = csvRows(version.content);
    return (
      <table className="cp-mini-table">
        <thead>
          <tr>
            {head.slice(0, 4).map((cell, index) => (
              <th key={index}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 3).map((row, index) => (
            <tr key={index}>
              {row.slice(0, 4).map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (artifact.kind === "code") {
    return <pre className="cp-mini-code">{version.content.split("\n").slice(0, 6).join("\n")}</pre>;
  }
  return <p className="cp-mini-doc">{plainExcerpt(version.content)}</p>;
}

/** A new artifact in the thread: what it is, how big, and a glance at it.
 * The title button stretches over the whole card, so the card opens it in
 * the side panel while its preview stays real table/code markup. */
function ArtifactCard({
  artifact,
  version,
  pending,
  active,
  onOpen,
}: {
  readonly artifact: Artifact;
  readonly version: ArtifactVersion | undefined;
  readonly pending: boolean;
  readonly active: boolean;
  readonly onOpen: () => void;
}) {
  const ready = !pending && version !== undefined;
  return (
    <article
      className="cp-card cp-artifact"
      data-active={active ? "true" : undefined}
      data-ready={ready ? "true" : undefined}
    >
      <div className="cp-artifact-head">
        <span className="cp-tile" data-kind={artifact.kind}>
          <KindIcon kind={artifact.kind} />
        </span>
        <div className="cp-artifact-title">
          <button
            type="button"
            className="cp-artifact-hit"
            disabled={!ready}
            aria-current={active ? "true" : undefined}
            onClick={onOpen}
          >
            {artifact.title}
          </button>
          <span>
            {ready ? (
              <>
                {KIND_LABEL[artifact.kind]} · v{version.version} · {artifactMeta(artifact, version)}
              </>
            ) : (
              <Shimmer>Writing {KIND_LABEL[artifact.kind].toLowerCase()}…</Shimmer>
            )}
          </span>
        </div>
        {ready ? (
          <span className="cp-artifact-open" aria-hidden="true">
            {active ? "Viewing" : "Open"}
            <CaretRight />
          </span>
        ) : null}
      </div>
      <div className="cp-artifact-preview" data-kind={artifact.kind}>
        {ready ? (
          <ArtifactPreview artifact={artifact} version={version} />
        ) : (
          <span className="cp-skeleton-lines" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        )}
      </div>
    </article>
  );
}

/** A revision of an artifact already in the thread: one line, not a card. */
function ArtifactUpdateLine({
  artifact,
  number,
  version,
  onOpen,
}: {
  readonly artifact: Artifact;
  readonly number: number;
  readonly version: ArtifactVersion | undefined;
  readonly onOpen: () => void;
}) {
  return (
    <div className="cp-artifact-update">
      <ClockCounterClockwise aria-hidden="true" />
      <span>
        Updated <b>{artifact.title}</b> to v{number}
        {version === undefined ? null : <span className="cp-artifact-note"> — {version.note}</span>}
      </span>
      <button type="button" onClick={onOpen}>
        View
      </button>
    </div>
  );
}

const OFFER_NOUN: Record<OfferKind, string> = {
  skill: "skill",
  workflow: "workflow",
  agent: "agent",
};

function OfferIcon({ kind }: { readonly kind: OfferKind }) {
  if (kind === "workflow") return <FlowArrow aria-hidden="true" />;
  if (kind === "agent") return <Robot aria-hidden="true" />;
  return <Lightning aria-hidden="true" />;
}

/** One quiet line for a decision already made. */
function ResolvedLine({
  done,
  children,
}: {
  readonly done: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="cp-resolved" data-done={done ? "true" : undefined}>
      {done ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
      <span>{children}</span>
    </div>
  );
}

/** The worker suggesting a skill, workflow or agent to install. Quiet, not
 * orange: only approvals are the attention moment. */
function OfferCard({
  part,
  onResolve,
}: {
  readonly part: OfferPart;
  readonly onResolve: (offerId: string, state: "installed" | "declined") => void;
}) {
  const noun = OFFER_NOUN[part.kind];
  if (part.state !== "offered") {
    return (
      <ResolvedLine done={part.state === "installed"}>
        {part.state === "installed" ? "Installed" : "Skipped"} the <b>{part.name}</b> {noun}
      </ResolvedLine>
    );
  }
  return (
    <section className="cp-card cp-offer" aria-label={`Suggested ${noun}: ${part.name}`}>
      <header className="cp-card-head">
        <span className="cp-tile">
          <OfferIcon kind={part.kind} />
        </span>
        <div className="cp-card-title">
          <span className="cp-eyebrow">Suggested {noun}</span>
          <b>{part.name}</b>
        </div>
      </header>
      <p className="cp-offer-summary">{part.summary}</p>
      {part.needs.length === 0 ? null : (
        <ul className="cp-offer-needs" aria-label="It will be able to">
          {part.needs.map((need) => (
            <li key={need}>{need}</li>
          ))}
        </ul>
      )}
      <div className="cp-card-actions">
        <button
          type="button"
          className="cp-btn cp-btn--primary"
          onClick={() => onResolve(part.id, "installed")}
        >
          Install
        </button>
        <button type="button" className="cp-btn" onClick={() => onResolve(part.id, "declined")}>
          Not now
        </button>
      </div>
    </section>
  );
}

/** A service the worker can't reach yet, with the reason it wants it. */
function ConnectCard({
  part,
  onResolve,
}: {
  readonly part: ConnectPart;
  readonly onResolve: (connectId: string, state: "connected" | "skipped") => void;
}) {
  if (part.state !== "needed") {
    return (
      <ResolvedLine done={part.state === "connected"}>
        {part.state === "connected" ? (
          <>
            <b>{part.service}</b> connected
          </>
        ) : (
          <>
            Skipped connecting <b>{part.service}</b>
          </>
        )}
      </ResolvedLine>
    );
  }
  return (
    <section className="cp-card cp-offer" aria-label={`Connect ${part.service}`}>
      <header className="cp-card-head">
        <span className="cp-tile">
          <Plugs aria-hidden="true" />
        </span>
        <div className="cp-card-title">
          <span className="cp-eyebrow">Connect a service</span>
          <b>{part.service}</b>
        </div>
      </header>
      <p className="cp-offer-summary">{part.reason}</p>
      <div className="cp-card-actions">
        <button
          type="button"
          className="cp-btn cp-btn--primary"
          onClick={() => onResolve(part.id, "connected")}
        >
          Connect {part.service}
        </button>
        <button type="button" className="cp-btn" onClick={() => onResolve(part.id, "skipped")}>
          Not now
        </button>
      </div>
    </section>
  );
}

type MessageHandlers = {
  readonly onOpenThread: (message: ChatMessage) => void;
  readonly onCopy: (message: ChatMessage) => void;
  readonly onRetry: (message: ChatMessage) => void;
  /** Run an agent's response again in its place. */
  readonly onRegenerate: (message: ChatMessage) => void;
  readonly onDecide: (approvalId: string, decision: ApprovalDecision) => void;
  readonly onReact: (messageId: string, emoji: string) => void;
  readonly onFeedback: (messageId: string, value: Feedback) => void;
  readonly onTogglePin: (messageId: string) => void;
  readonly onCopyLink: (messageId: string) => void;
  readonly onOpenArtifact: (artifactId: string, version: number) => void;
  readonly onStartPlan: (messageId: string) => void;
  readonly onResolveOffer: (offerId: string, state: "installed" | "declined") => void;
  readonly onResolveConnect: (connectId: string, state: "connected" | "skipped") => void;
  /** A file in a message was clicked; the whole set comes along. */
  readonly onOpenFile: (files: readonly FilePart[], index: number) => void;
  /** A generated image failed; make it again. */
  readonly onRetryImage: (partId: string) => void;
};

function PartView({
  group,
  message,
  streaming,
  latest,
  artifacts,
  activeArtifactId,
  planStartable,
  handlers,
}: {
  readonly group: PartGroup;
  readonly message: ChatMessage;
  readonly streaming: boolean;
  /** The newest agent answer: a very long one starts open, not folded. */
  readonly latest: boolean;
  readonly artifacts: ReadonlyMap<string, Artifact>;
  readonly activeArtifactId: string | null;
  readonly planStartable: boolean;
  readonly handlers: MessageHandlers;
}) {
  if (group.kind === "activity") return <ActivityBlock items={group.items} live={streaming} />;
  if (group.kind === "files") {
    return <MessageFiles files={group.files} onOpenFile={handlers.onOpenFile} />;
  }
  const { part } = group;
  switch (part.type) {
    case "text":
      return <TextBlock part={part} streaming={streaming} latest={latest} />;
    case "approval":
      return <ApprovalCard part={part} onDecide={handlers.onDecide} />;
    case "sources":
      return <SourcesList part={part} />;
    case "plan":
      return (
        <PlanCard
          part={part}
          startable={planStartable}
          onStart={() => handlers.onStartPlan(message.id)}
        />
      );
    case "offer":
      return <OfferCard part={part} onResolve={handlers.onResolveOffer} />;
    case "connect":
      return <ConnectCard part={part} onResolve={handlers.onResolveConnect} />;
    case "image":
      return (
        <ImageOutput part={part} onOpen={handlers.onOpenFile} onRetry={handlers.onRetryImage} />
      );
    case "artifact": {
      const artifact = artifacts.get(part.artifactId);
      if (artifact === undefined) return null;
      const version = artifactVersion(artifact, part.version);
      const open = () => handlers.onOpenArtifact(artifact.id, part.version);
      return part.change === "updated" ? (
        <ArtifactUpdateLine
          artifact={artifact}
          number={part.version}
          version={version}
          onOpen={open}
        />
      ) : (
        <ArtifactCard
          artifact={artifact}
          version={version}
          pending={part.pending === true}
          active={activeArtifactId === artifact.id}
          onOpen={open}
        />
      );
    }
  }
}

function ActionButton({
  label,
  pressed,
  vote,
  onClick,
  children,
}: {
  readonly label: string;
  readonly pressed?: boolean;
  /** Colours a selected vote: green for good, red for bad. */
  readonly vote?: Feedback;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="cp-tip"
      data-tip={label}
      aria-label={label}
      aria-pressed={pressed}
      data-vote={vote}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** aicss message-actions sizing: 12px glyphs on a hairline stroke that
 * stays 1.125px whatever the icon size. */
const GLYPH = { size: 12, strokeWidth: 1.125, absoluteStrokeWidth: true } as const;

/** A toolbar menu that costs nothing until first opened. Radix's menu root
 * listens on the whole document, so a long thread mounts only a plain
 * button per row and swaps in the real menu the first time it is pressed. */
function LazyMenu({
  label,
  icon,
  side,
  className,
  children,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly side: "top" | "bottom";
  readonly className: string;
  readonly children: ReactNode;
}) {
  const [state, setState] = useState<"dormant" | "open" | "closed">("dormant");
  if (state === "dormant") {
    return (
      <button
        type="button"
        className="cp-tip"
        data-tip={label}
        aria-label={label}
        aria-haspopup="menu"
        onClick={() => setState("open")}
      >
        {icon}
      </button>
    );
  }
  return (
    <Menu open={state === "open"} onOpenChange={(open) => setState(open ? "open" : "closed")}>
      <MenuTrigger asChild>
        <button type="button" className="cp-tip" data-tip={label} aria-label={label}>
          {icon}
        </button>
      </MenuTrigger>
      <MenuContent
        side={side}
        align="start"
        sideOffset={side === "top" ? 8 : 4}
        className={className}
      >
        {children}
      </MenuContent>
    </Menu>
  );
}

/** A response action. A list of these decides which show and in what
 * order; the default is none, so a surface opts into each one. `pin` and
 * `link` go in a More menu at the end. */
type MessageActionId =
  | "upvote"
  | "downvote"
  | "copy"
  | "regenerate"
  | "react"
  | "reply"
  | "pin"
  | "link";

const NO_ACTIONS: readonly MessageActionId[] = [];

const MORE_ACTIONS: ReadonlySet<MessageActionId> = new Set(["pin", "link"]);

/** The action row under an agent's response, in the order `actions` gives.
 * It sits inline below the text, never floating over other rows, and only
 * agent responses get one. Tooltips are CSS-only and menus mount lazily,
 * so a long thread carries no per-row machinery. */
function MessageActions({
  message,
  actions,
  inThread,
  copied,
  handlers,
}: {
  readonly message: ChatMessage;
  readonly actions: readonly MessageActionId[];
  readonly inThread: boolean;
  readonly copied: boolean;
  readonly handlers: MessageHandlers;
}) {
  const inline = actions.filter(
    (action) => !MORE_ACTIONS.has(action) && !(inThread && action === "reply"),
  );
  const more = actions.filter((action) => MORE_ACTIONS.has(action));
  const button = (action: MessageActionId): ReactNode => {
    switch (action) {
      case "upvote":
        return (
          <ActionButton
            key={action}
            vote="up"
            label="Good response"
            pressed={message.feedback === "up"}
            onClick={() => handlers.onFeedback(message.id, "up")}
          >
            <ThumbsUp {...GLYPH} aria-hidden="true" />
          </ActionButton>
        );
      case "downvote":
        return (
          <ActionButton
            key={action}
            vote="down"
            label="Bad response"
            pressed={message.feedback === "down"}
            onClick={() => handlers.onFeedback(message.id, "down")}
          >
            <ThumbsDown {...GLYPH} aria-hidden="true" />
          </ActionButton>
        );
      case "copy":
        return (
          <ActionButton
            key={action}
            label={copied ? "Copied" : "Copy"}
            onClick={() => handlers.onCopy(message)}
          >
            {copied ? (
              <Check {...GLYPH} aria-hidden="true" />
            ) : (
              <Copy {...GLYPH} aria-hidden="true" />
            )}
          </ActionButton>
        );
      case "regenerate":
        return (
          <ActionButton
            key={action}
            label="Regenerate"
            onClick={() => handlers.onRegenerate(message)}
          >
            <ArrowClockwise {...GLYPH} aria-hidden="true" />
          </ActionButton>
        );
      case "react":
        return (
          <LazyMenu
            key={action}
            label="Add reaction"
            icon={<Smiley {...GLYPH} aria-hidden="true" />}
            side="top"
            className="cp-emoji-menu"
          >
            {REACTIONS.map((emoji) => (
              <MenuItem key={emoji} onSelect={() => handlers.onReact(message.id, emoji)}>
                {emoji}
              </MenuItem>
            ))}
          </LazyMenu>
        );
      case "reply":
        return (
          <ActionButton
            key={action}
            label="Reply in thread"
            onClick={() => handlers.onOpenThread(message)}
          >
            <ArrowBendUpLeft {...GLYPH} aria-hidden="true" />
          </ActionButton>
        );
      case "pin":
      case "link":
        return null;
    }
  };
  return (
    <div className="cp-actions" role="toolbar" aria-label="Response actions">
      {inline.map(button)}
      {more.length === 0 ? null : (
        <LazyMenu
          label="More actions"
          icon={<DotsThree {...GLYPH} aria-hidden="true" />}
          side="bottom"
          className="cp-more-menu"
        >
          {more.map((action) =>
            action === "pin" ? (
              <MenuItem key={action} onSelect={() => handlers.onTogglePin(message.id)}>
                <PushPin aria-hidden="true" />
                {message.pinned === true ? "Unpin" : "Pin to workbench"}
              </MenuItem>
            ) : (
              <MenuItem key={action} onSelect={() => handlers.onCopyLink(message.id)}>
                <LinkSimple aria-hidden="true" />
                Copy link
              </MenuItem>
            ),
          )}
        </LazyMenu>
      )}
    </div>
  );
}

function ReactionBar({
  messageId,
  reactions,
  onReact,
}: {
  readonly messageId: string;
  readonly reactions: readonly Reaction[];
  readonly onReact: (messageId: string, emoji: string) => void;
}) {
  return (
    <div className="cp-reactions">
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          aria-pressed={reaction.mine}
          aria-label={`${reaction.emoji} ${reaction.count}`}
          onClick={() => onReact(messageId, reaction.emoji)}
        >
          <span>{reaction.emoji}</span>
          <span className="cp-reaction-count">{reaction.count}</span>
        </button>
      ))}
    </div>
  );
}

function ThreadLink({
  summary,
  active,
  onOpen,
}: {
  readonly summary: ThreadSummary;
  readonly active: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="cp-thread-link"
      data-active={active ? "true" : undefined}
      onClick={onOpen}
    >
      <b>
        {summary.count} {summary.count === 1 ? "reply" : "replies"}
      </b>
      <span className="cp-thread-last">Last reply {relativeTime(summary.lastAt)}</span>
      <span className="cp-thread-view">
        View thread <CaretRight aria-hidden="true" />
      </span>
    </button>
  );
}

type MessageRowProps = {
  readonly message: ChatMessage;
  readonly author: Participant;
  readonly own: boolean;
  /** `thread` is the side panel: no thread link, no reply action. */
  readonly variant: "timeline" | "thread";
  readonly threadOpen: boolean;
  readonly copied: boolean;
  /** The newest agent response keeps its action row visible; older ones
   * reveal theirs on hover. */
  readonly latest: boolean;
  /** Which actions an agent response offers, in order; none by default. */
  readonly actions?: readonly MessageActionId[];
  /** The avatar column. Off, others' messages run the full width: with one
   * person and one agent, the agent's answer is just text. */
  readonly avatars?: boolean;
  /** The name, role and time over others' messages. */
  readonly names?: boolean;
  readonly handlers: MessageHandlers;
} & RowScope;

/** The props that differ from row to row, narrowed to what each row shows:
 * a row without artifacts never sees the artifact map, and only the row
 * holding the open artifact (or a startable plan) is told about it. That
 * keeps memoization intact when a panel opens or an artifact streams. */
type RowScope = {
  readonly artifacts: ReadonlyMap<string, Artifact>;
  readonly activeArtifactId: string | null;
  readonly planStartable: boolean;
};

const NO_ARTIFACTS: ReadonlyMap<string, Artifact> = new Map();

function rowScope(
  message: ChatMessage,
  artifacts: ReadonlyMap<string, Artifact>,
  activeArtifactId: string | null,
  planStartable: boolean,
): RowScope {
  const ids = message.parts.flatMap((part) => (part.type === "artifact" ? [part.artifactId] : []));
  return {
    artifacts: ids.length === 0 ? NO_ARTIFACTS : artifacts,
    activeArtifactId:
      activeArtifactId !== null && ids.includes(activeArtifactId) ? activeArtifactId : null,
    planStartable:
      planStartable &&
      message.parts.some((part) => part.type === "plan" && part.state === "proposed"),
  };
}

/** Memoized on its props: a streaming tick re-renders only the row whose
 * message object changed, never the rest of the timeline. */
const MessageRow = memo(function MessageRow({
  message,
  author,
  own,
  variant,
  artifacts,
  activeArtifactId,
  planStartable,
  threadOpen,
  copied,
  latest,
  actions: actionIds = NO_ACTIONS,
  avatars = true,
  names = true,
  handlers,
}: MessageRowProps) {
  const groups = useMemo(() => groupParts(message.parts), [message.parts]);
  const streaming = message.status === "streaming";
  const lastGroup = groups.at(-1);
  const inThread = variant === "thread";
  // What a person sends rides above their bubble, as it sat above the
  // composer; an agent's files stay in line with its answer.
  const sentFiles = own
    ? groups.flatMap((group) => (group.kind === "files" ? group.files : []))
    : [];
  const shown = own ? groups.filter((group) => group.kind !== "files") : groups;
  // While streaming, only the trailing part is live; earlier parts are settled.
  const body = shown.map((group) => (
    <PartView
      key={group.key}
      group={group}
      message={message}
      streaming={streaming && group === lastGroup}
      latest={latest}
      artifacts={artifacts}
      activeArtifactId={activeArtifactId}
      planStartable={planStartable}
      handlers={handlers}
    />
  ));
  // A turn with nothing to show yet stays hidden; the working label below
  // the thread covers that moment, as it does in the live chat.
  if (streaming && groups.length === 0) return null;
  const offersActions = actionIds.some((action) => !(inThread && action === "reply"));
  const actions =
    own || author.kind !== "agent" || streaming || !offersActions ? null : (
      <MessageActions
        message={message}
        actions={actionIds}
        inThread={inThread}
        copied={copied}
        handlers={handlers}
      />
    );
  const reactions =
    message.reactions === undefined || message.reactions.length === 0 ? null : (
      <ReactionBar
        messageId={message.id}
        reactions={message.reactions}
        onReact={handlers.onReact}
      />
    );
  const threadLink =
    inThread || message.thread === undefined ? null : (
      <ThreadLink
        summary={message.thread}
        active={threadOpen}
        onOpen={() => handlers.onOpenThread(message)}
      />
    );
  // One quiet line under the message: reactions, replies, then the actions.
  // It sits in the row's bottom spacing, so it never changes the rhythm.
  const footer =
    reactions === null && threadLink === null && actions === null ? null : (
      <div className="cp-footer">
        {reactions}
        {threadLink}
        {actions}
      </div>
    );
  const pin =
    message.pinned === true ? (
      <span className="cp-pinned">
        <PushPin aria-hidden="true" /> Pinned
      </span>
    ) : null;

  if (own) {
    return (
      <article className="cp-row cp-row--own" data-variant={variant} data-status={message.status}>
        <div className="cp-own">
          {pin}
          {sentFiles.length === 0 ? null : (
            <MessageFiles files={sentFiles} onOpenFile={handlers.onOpenFile} />
          )}
          {body.length === 0 ? null : <div className="cp-bubble">{body}</div>}
          {message.status === "failed" ? (
            <p className="cp-failed">
              <Warning aria-hidden="true" /> Not delivered.
              <button type="button" onClick={() => handlers.onRetry(message)}>
                Retry
              </button>
            </p>
          ) : message.status === "sending" ? (
            <p className="cp-sending">Sending…</p>
          ) : null}
          {footer}
        </div>
      </article>
    );
  }

  return (
    <article
      className="cp-row"
      data-variant={variant}
      data-status={message.status}
      data-latest={latest ? "true" : undefined}
      data-avatar={avatars ? undefined : "off"}
      // With no name line, who wrote it and when still reach a screen reader.
      aria-label={names ? undefined : `${author.name}, ${timeLabel(message.at)}`}
    >
      {avatars ? (
        <span className="chat-thread-avatar">
          <IdentityAvatar kind={author.kind} name={author.name} principalId={author.id} />
        </span>
      ) : null}
      <div className="cp-main">
        {names || message.via !== undefined || pin !== null ? (
          <header className="cp-head">
            {names ? (
              <>
                <b>{author.name}</b>
                {author.role === undefined || inThread ? null : (
                  <span className="cp-role">{author.role}</span>
                )}
                <time dateTime={message.at}>{timeLabel(message.at)}</time>
              </>
            ) : null}
            {message.via === undefined ? null : (
              <span className="cp-via">
                <Repeat aria-hidden="true" /> {message.via}
              </span>
            )}
            {pin}
          </header>
        ) : null}
        <div className="cp-parts">{body}</div>
        {footer}
      </div>
    </article>
  );
});

/** No messages yet: the app's own new-workbench screen (`new-wrap` /
 * `new-title` from pages/new-workbench.css), the composer under the title. */
function EmptyConversation({ composer }: { readonly composer: ReactNode }) {
  return (
    <div className="new-wrap">
      <h1 className="new-title">What should we work on?</h1>
      {composer}
    </div>
  );
}

function distanceFromBottom(scroller: HTMLElement): number {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
}

/** Within this of the bottom counts as at the bottom. */
const NEAR_BOTTOM = 48;
/** Scrolling this soon after the person's own input is theirs; later, it is layout. */
const INTENT_WINDOW_MS = 400;

/** Keeps the view pinned to the newest message unless the person has
 * scrolled up to read; resizing content (a streaming token, an opened
 * fold) follows the bottom only while pinned. Only the person's own input
 * (wheel, touch, keys, scrollbar drag) can unpin it: images loading and
 * folds measuring late shift the scroll position too, and must not count
 * as the person leaving. Scroll position is the one piece of UI state a
 * conversation owns — it is never data. */
function useStickToBottom() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  /** When the person last touched the scroller. */
  const intentAt = useRef(0);
  /** A jump to a turn is in flight: its first frames pass within reach of
   * the bottom, which must not read as the person coming back to it. */
  const travelling = useRef(false);
  const [atBottom, setAtBottom] = useState(true);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (scroller === null || content === null) return;
    const toBottom = () => {
      scroller.scrollTop = scroller.scrollHeight;
    };
    toBottom();
    const markIntent = () => {
      intentAt.current = performance.now();
      travelling.current = false;
    };
    const onScroll = () => {
      if (travelling.current) return;
      const near = distanceFromBottom(scroller) < NEAR_BOTTOM;
      if (near) {
        pinned.current = true;
      } else if (performance.now() - intentAt.current < INTENT_WINDOW_MS) {
        pinned.current = false;
      } else if (pinned.current) {
        // A layout shift moved us, not the person: follow the bottom again.
        toBottom();
      }
      setAtBottom(pinned.current);
    };
    const observer = new ResizeObserver(() => {
      if (pinned.current) toBottom();
    });
    // The content growing (a new token or room made for attachments
    // floating over the composer) and the viewport shrinking both move the
    // bottom. Border box: added padding is growth too.
    observer.observe(content, { box: "border-box" });
    observer.observe(scroller);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", markIntent, { passive: true });
    scroller.addEventListener("touchmove", markIntent, { passive: true });
    scroller.addEventListener("pointerdown", markIntent);
    scroller.addEventListener("keydown", markIntent);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", markIntent);
      scroller.removeEventListener("touchmove", markIntent);
      scroller.removeEventListener("pointerdown", markIntent);
      scroller.removeEventListener("keydown", markIntent);
    };
  }, []);

  /** Glides to wherever `target` says, as if the person had scrolled: one
   * eased motion, re-aimed every frame, so it lands exactly even while the
   * content under it changes height. Both jumps (to a turn, to the latest)
   * move this way. */
  const glide = useCallback((target: () => number) => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const distance = Math.abs(target() - scroller.scrollTop);
    if (distance <= 2) return;
    intentAt.current = performance.now();
    const started = intentAt.current;
    pinned.current = false;
    travelling.current = true;
    setAtBottom(false);
    const arrive = () => {
      travelling.current = false;
      pinned.current = distanceFromBottom(scroller) < NEAR_BOTTOM;
      setAtBottom(pinned.current);
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      scroller.scrollTop = target();
      // One more pass once the turns there have rendered at full height.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (intentAt.current === started) scroller.scrollTop = target();
          arrive();
        }),
      );
      return;
    }
    // Longer jumps take a little longer, never sluggish.
    const duration = Math.min(320 + distance * 0.08, 720);
    const begin = performance.now();
    let covered = 0;
    const step = (now: number) => {
      // The person scrolled: they own the scroller again.
      if (intentAt.current !== started) return;
      const progress = Math.min((now - begin) / duration, 1);
      const eased = 1 - (1 - progress) ** 3;
      // Each frame covers its share of what is left, measured now. Turns
      // rendering above the view make the browser shift scrollTop to hold
      // the view still; a start position kept from frame one would then be
      // stale and the glide would lurch.
      const share = covered >= 1 ? 1 : (eased - covered) / (1 - covered);
      covered = eased;
      const at = scroller.scrollTop;
      scroller.scrollTop = at + (target() - at) * share;
      if (progress < 1) requestAnimationFrame(step);
      else arrive();
    };
    requestAnimationFrame(step);
  }, []);

  /** Back to the latest message; arriving there pins to the bottom again. */
  const scrollToBottom = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    glide(() => scroller.scrollHeight - scroller.clientHeight);
  }, [glide]);

  /** To a turn, landing it clear of the floating pill. Measured fresh every
   * frame: turns skipped by content-visibility take their real height as
   * the glide passes them, and the aim follows. */
  const scrollToElement = useCallback(
    (element: Element) => {
      const scroller = scrollRef.current;
      if (scroller === null) return;
      glide(() =>
        Math.min(
          element.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            scroller.scrollTop -
            PILL_CLEARANCE,
          scroller.scrollHeight - scroller.clientHeight,
        ),
      );
    },
    [glide],
  );

  return { scrollRef, contentRef, pinned, atBottom, scrollToBottom, scrollToElement };
}

/** Room left above a jumped-to turn for the frosted pill floating there. */
const PILL_CLEARANCE = 64;

/** One turn on the map: what was asked (or what ran), and the reply. */
type MapEntry = {
  /** The id of the entry the turn starts at; jumping lands there. */
  readonly id: string;
  readonly title: string;
  readonly preview: string;
};

function plainLine(markdown: string): string {
  const line = markdown.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line
    .replace(/[*_`#>]/g, "")
    .replace(/^\s*(?:[-*]|\d+\.)\s+/, "")
    .trim();
}

/** Splits a thread into turns. A person's message starts one; so does an
 * agent message nobody asked for (a scheduled run, an opening greeting).
 * The title is what was said; the preview is the first reply with text. */
function conversationMap(
  entries: readonly TimelineEntry[],
  participants: ReadonlyMap<string, Participant>,
): readonly MapEntry[] {
  const turns: MapEntry[] = [];
  let current: { id: string; title: string; preview: string | null } | null = null;
  const flush = () => {
    if (current !== null) {
      turns.push({ id: current.id, title: current.title, preview: current.preview ?? "" });
    }
    current = null;
  };
  for (const entry of entries) {
    if (entry.type !== "message" || entry.status === "streaming") continue;
    const said = plainLine(messageText(entry));
    const files = entry.parts.filter((part) => part.type === "file").length;
    if (participants.get(entry.authorId)?.kind === "person") {
      flush();
      const shared = files === 1 ? "Shared a file" : `Shared ${files} files`;
      current = { id: entry.id, title: said === "" ? shared : said, preview: null };
      continue;
    }
    if (current === null || entry.via !== undefined) {
      flush();
      const day = new Date(entry.at).toLocaleDateString([], { month: "short", day: "numeric" });
      current = {
        id: entry.id,
        title: entry.via === undefined ? said : `${entry.via} · ${day}`,
        preview: said === "" ? null : said,
      };
      continue;
    }
    if (current.preview === null && said !== "") current.preview = said;
  }
  flush();
  return turns;
}

type ReadingPosition = { readonly activeId: string | null; readonly visibleIds: readonly string[] };

/** Which turn is being read (the last to cross the upper third of the
 * view, or the last one at the bottom) and which turns are on screen. */
function useReadingPosition(
  scrollRef: RefObject<HTMLDivElement | null>,
  map: readonly MapEntry[] | undefined,
): ReadingPosition {
  const [position, setPosition] = useState<ReadingPosition>({ activeId: null, visibleIds: [] });
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null || map === undefined || map.length < 2) return;
    const starts = map.map((turn) =>
      scroller.querySelector(`[data-entry-id="${CSS.escape(turn.id)}"]`),
    );
    let frame = 0;
    const measure = () => {
      frame = 0;
      const view = scroller.getBoundingClientRect();
      const tops = starts.map((element) => element?.getBoundingClientRect().top ?? Infinity);
      const atBottom = distanceFromBottom(scroller) < 4;
      const readingLine = view.top + view.height / 3;
      const visibleIds = map
        .filter((_, index) => {
          const start = tops[index] ?? Infinity;
          const end = tops[index + 1] ?? Infinity;
          return start < view.bottom && end > view.top + PILL_CLEARANCE;
        })
        .map((turn) => turn.id);
      let activeId = map[0]?.id ?? null;
      tops.forEach((top, index) => {
        if (top <= readingLine) activeId = map[index]?.id ?? activeId;
      });
      if (atBottom) activeId = visibleIds.at(-1) ?? activeId;
      setPosition((previous) =>
        previous.activeId === activeId &&
        previous.visibleIds.length === visibleIds.length &&
        previous.visibleIds.every((id, index) => id === visibleIds[index])
          ? previous
          : { activeId, visibleIds },
      );
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [scrollRef, map]);
  return position;
}

/** The rail itself: stateless but for which tick is previewed. Ticks are
 * faint, the turns on screen darker, the one being read solid. Pointing
 * at the rail widens what's on screen; a tick shows its turn in a card
 * and a click jumps there. One tab stop: arrows move along the rail. */
function ConversationMap({
  entries,
  activeId,
  visibleIds,
  onSelect,
}: {
  readonly entries: readonly MapEntry[];
  readonly activeId: string | null;
  readonly visibleIds: readonly string[];
  readonly onSelect: (id: string) => void;
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<{ readonly id: string; readonly top: number } | null>(
    null,
  );
  const visible = new Set(visibleIds);
  const focusId = activeId ?? entries[0]?.id;
  const show = (id: string, tick: HTMLElement) => {
    // The card is positioned in the full-height map, not the rail, which
    // only spans the ticks.
    const map = mapRef.current;
    if (map === null) return;
    const box = map.getBoundingClientRect();
    const mark = tick.getBoundingClientRect();
    // Clamped so a card near either end stays on screen.
    const top = Math.min(Math.max(mark.top + mark.height / 2 - box.top, 56), box.height - 56);
    setPreview({ id, top });
  };
  const previewed = preview === null ? undefined : entries.find((turn) => turn.id === preview.id);
  return (
    <div className="cp-map" ref={mapRef}>
      <nav
        className="cp-map-rail"
        aria-label="Conversation map"
        onPointerLeave={() => setPreview(null)}
        onBlur={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            setPreview(null);
          }
        }}
      >
        {entries.map((turn) => (
          <button
            key={turn.id}
            type="button"
            className="cp-map-tick"
            aria-label={turn.title}
            aria-current={turn.id === activeId ? "true" : undefined}
            data-visible={visible.has(turn.id) ? "true" : undefined}
            tabIndex={turn.id === focusId ? 0 : -1}
            onPointerEnter={(event) => show(turn.id, event.currentTarget)}
            onFocus={(event) => show(turn.id, event.currentTarget)}
            onClick={() => onSelect(turn.id)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              const next =
                event.key === "ArrowDown"
                  ? event.currentTarget.nextElementSibling
                  : event.currentTarget.previousElementSibling;
              if (next instanceof HTMLElement) next.focus();
            }}
          >
            <span />
          </button>
        ))}
      </nav>
      {previewed === undefined || preview === null ? null : (
        <div className="cp-map-preview" style={{ top: preview.top }} aria-hidden="true">
          <b>{previewed.title}</b>
          {previewed.preview === "" ? null : <p>{previewed.preview}</p>}
        </div>
      )}
    </div>
  );
}

/** Where a timeline entry's message sits: the message itself, not its
 * wrapper, which also holds the day header that comes and goes as older
 * messages land above it. */
function messageBox(entry: Element): DOMRect {
  return (entry.lastElementChild ?? entry).getBoundingClientRect();
}

function Conversation({
  children,
  label = "Conversation",
  working = false,
  map,
  sentId,
  firstId,
  hasEarlier = false,
  onReachStart,
  onAtBottomChange,
}: {
  readonly children: ReactNode;
  readonly label?: string;
  /** An agent is mid-turn: the jump button pulses dots until hovered. */
  readonly working?: boolean;
  /** Turns for the conversation map; omitted, there is no rail. */
  readonly map?: readonly MapEntry[];
  /** The person's latest message. When it changes they just sent, and
   * wherever they had scrolled to, the conversation glides back down. */
  readonly sentId?: string;
  /** The first message shown. A long conversation shows a window of its
   * history; when older messages are added above, or old ones pruned, this
   * changes, and the message being read stays exactly where it was. */
  readonly firstId?: string;
  /** Older messages exist beyond the window: nearing the top asks for them. */
  readonly hasEarlier?: boolean;
  readonly onReachStart?: () => void;
  /** Whether the reader is at the newest message: while they are, the host
   * can prune old messages off the top without moving anything they see. */
  readonly onAtBottomChange?: (atBottom: boolean) => void;
}) {
  const { scrollRef, contentRef, pinned, atBottom, scrollToBottom, scrollToElement } =
    useStickToBottom();

  useEffect(() => {
    onAtBottomChange?.(atBottom);
  }, [atBottom, onAtBottomChange]);

  // Where the reader is: the first message at or below the top of the view,
  // and how far down the view it starts. Kept current as they scroll.
  const anchor = useRef<{ readonly id: string; readonly offset: number } | null>(null);
  const recordAnchor = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const top = scroller.getBoundingClientRect().top;
    for (const element of scroller.querySelectorAll<HTMLElement>("[data-entry-id]")) {
      const id = element.dataset.entryId;
      const box = messageBox(element);
      if (id === undefined || box.bottom <= top) continue;
      anchor.current = { id, offset: box.top - top };
      return;
    }
  }, [scrollRef]);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    let frame = 0;
    const record = () => {
      frame = 0;
      recordAnchor();
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(record);
    };
    record();
    scroller.addEventListener("scroll", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
    };
  }, [scrollRef, recordAnchor]);

  // Messages were added above or pruned from the top: put the one being
  // read back where it was before the frame is drawn. The browser's own
  // anchoring is off for this scroller (see `.cp-scroll`), so this is the
  // only correction. At the bottom, stick-to-bottom already holds the view.
  const seenFirst = useRef(firstId);
  useLayoutEffect(() => {
    if (firstId === seenFirst.current) return;
    seenFirst.current = firstId;
    const scroller = scrollRef.current;
    const held = anchor.current;
    if (scroller === null || held === null || pinned.current) return;
    const element = scroller.querySelector(`[data-entry-id="${CSS.escape(held.id)}"]`);
    if (element === null) return;
    const drift = messageBox(element).top - scroller.getBoundingClientRect().top - held.offset;
    if (Math.abs(drift) > 1) scroller.scrollTop += drift;
  }, [firstId, scrollRef, pinned]);

  // Nearing the top of a window with more history beyond it: ask for more,
  // early enough that it arrives before the reader reaches the edge. Re-armed
  // whenever the window changes, so a still-visible sentinel asks again.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const scroller = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!hasEarlier || onReachStart === undefined || scroller === null || sentinel === null) {
      return;
    }
    const observer = new IntersectionObserver(
      (records) => {
        if (!records.some((record) => record.isIntersecting)) return;
        // Exactly where the reader is as the request goes out, not as of
        // the last frame: that is what the new page is measured against.
        recordAnchor();
        onReachStart();
      },
      { root: scroller, rootMargin: "1200px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasEarlier, onReachStart, firstId, scrollRef, recordAnchor]);
  const seenSent = useRef(sentId);
  useEffect(() => {
    if (sentId === seenSent.current) return;
    seenSent.current = sentId;
    scrollToBottom();
  }, [sentId, scrollToBottom]);
  const { activeId, visibleIds } = useReadingPosition(scrollRef, map);
  return (
    <div className="cp-conversation">
      {map === undefined || map.length < 2 ? null : (
        <ConversationMap
          entries={map}
          activeId={activeId}
          visibleIds={visibleIds}
          onSelect={(id) => {
            const start = scrollRef.current?.querySelector(`[data-entry-id="${CSS.escape(id)}"]`);
            if (start !== null && start !== undefined) scrollToElement(start);
          }}
        />
      )}
      <div className="cp-scroll" ref={scrollRef}>
        <div className="cp-column" ref={contentRef} role="log" aria-label={label}>
          {hasEarlier ? (
            <div ref={sentinelRef} className="cp-earlier" role="status">
              Loading earlier messages…
            </div>
          ) : null}
          {children}
        </div>
      </div>
      {atBottom ? null : (
        <button
          type="button"
          className="cp-jump"
          data-working={working ? "true" : undefined}
          aria-label={working ? "Jump to latest — still working" : "Jump to latest"}
          onClick={scrollToBottom}
        >
          <ArrowDown className="cp-jump-arrow" aria-hidden="true" />
          {working ? (
            <span className="cp-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          ) : null}
        </button>
      )}
    </div>
  );
}

/** The newest agent response in a list, the one whose actions stay visible. */
function latestAgentMessageId(
  entries: readonly TimelineEntry[],
  participants: ReadonlyMap<string, Participant>,
): string | undefined {
  return entries.findLast(
    (entry) =>
      entry.type === "message" &&
      entry.status !== "streaming" &&
      participants.get(entry.authorId)?.kind === "agent",
  )?.id;
}

/** Memoized: typing in the composer re-renders the playground, and with
 * stable props the list (and its date math over every entry) is skipped. */
const Timeline = memo(function Timeline({
  entries,
  participants,
  artifacts,
  meId,
  activeArtifactId,
  openThreadId,
  copiedId,
  planStartable,
  actions = NO_ACTIONS,
  avatars = true,
  names = true,
  handlers,
}: {
  readonly entries: readonly TimelineEntry[];
  readonly participants: ReadonlyMap<string, Participant>;
  readonly artifacts: ReadonlyMap<string, Artifact>;
  readonly meId: string;
  readonly activeArtifactId: string | null;
  readonly openThreadId: string | null;
  readonly copiedId: string | null;
  readonly planStartable: boolean;
  /** Actions under each agent response, in order; none by default. */
  readonly actions?: readonly MessageActionId[];
  /** The avatar column beside others' messages. */
  readonly avatars?: boolean;
  /** The name, role and time over others' messages. */
  readonly names?: boolean;
  readonly handlers: MessageHandlers;
}) {
  const latestId = latestAgentMessageId(entries, participants);
  return entries.map((entry, index) => {
    const previous = entries[index - 1];
    const divider =
      previous === undefined || !sameDay(previous.at, entry.at) ? (
        <DayDivider at={entry.at} />
      ) : null;
    if (entry.type === "system") {
      return (
        <div key={entry.id} className="cp-entry" data-entry-id={entry.id}>
          {divider}
          <SystemLine entry={entry} />
        </div>
      );
    }
    return (
      <div key={entry.id} className="cp-entry" data-entry-id={entry.id}>
        {divider}
        <MessageRow
          message={entry}
          author={participants.get(entry.authorId) ?? UNKNOWN_AUTHOR}
          own={entry.authorId === meId}
          variant="timeline"
          {...rowScope(entry, artifacts, activeArtifactId, planStartable)}
          threadOpen={openThreadId === entry.id}
          copied={copiedId === entry.id}
          latest={latestId === entry.id}
          actions={actions}
          avatars={avatars}
          names={names}
          handlers={handlers}
        />
      </div>
    );
  });
});

const UNKNOWN_AUTHOR: Participant = { id: "unknown", kind: "person", name: "Unknown" };

/** Pastes at least this long become an attachment, as in Claude. */
const LONG_PASTE_CHARS = 2000;
/** Claude's per-message cap. */
const MAX_FILES = 20;
const MAX_FILE_MB = 20;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
/** Text and code files read for a preview: up to this size, this much shown. */
const MAX_TEXT_READ_BYTES = 1024 * 1024;
const MAX_TEXT_PREVIEW_CHARS = 20_000;
/** A dropped folder is walked for files up to this many entries, so a
 * stray `node_modules` can't hang the tab. */
const MAX_FOLDER_ENTRIES = 500;
/** A sent batch past this many folds the rest behind a "+N" tile. */
const MESSAGE_FILES_SHOWN = 6;
/** The stack's deck shows this many cards; its badge counts them all. */
const STACK_LIMIT = 5;

/** What makes the same file the same: name, size and last change. */
function fingerprintOf(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

/** Files from a drop, a paste or the picker, with the folders they came
 * out of (a dropped folder is walked for the files inside it). */
type IncomingFiles = {
  readonly files: readonly File[];
  readonly folders: readonly string[];
  /** A folder held more than the walk would read: `files` is only the start. */
  readonly truncated?: boolean;
};

type Intake = { readonly accepted: readonly File[]; readonly notice: string | null };

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Which incoming files join a draft already holding `held`: nothing
 * empty, nothing over the size cap, no file twice, and no more than the
 * count cap in all. Anything left out is said in one line: how many were
 * added, and what was left out and why. */
function intakeFiles(incoming: IncomingFiles, held: readonly Attachment[]): Intake {
  const seen = new Set(
    held.flatMap((item) => (item.fingerprint === undefined ? [] : [item.fingerprint])),
  );
  const empty: File[] = [];
  const tooBig: File[] = [];
  const twice: File[] = [];
  const fitting: File[] = [];
  for (const file of incoming.files) {
    const fingerprint = fingerprintOf(file);
    if (file.size === 0) empty.push(file);
    else if (file.size > MAX_FILE_BYTES) tooBig.push(file);
    else if (seen.has(fingerprint)) twice.push(file);
    else {
      seen.add(fingerprint);
      fitting.push(file);
    }
  }
  const room = Math.max(0, MAX_FILES - held.length);
  const accepted = fitting.slice(0, room);
  const over = fitting.length - accepted.length;
  const problems = [
    over === 0 && incoming.truncated !== true
      ? null
      : incoming.truncated === true
        ? `the rest left out (up to ${MAX_FILES} per message)`
        : `${count(over, "file", "files")} left out (up to ${MAX_FILES} per message)`,
    tooBig.length === 0
      ? null
      : tooBig.length === 1
        ? `${tooBig[0]?.name} is over ${MAX_FILE_MB} MB`
        : `${count(tooBig.length, "file", "files")} are over ${MAX_FILE_MB} MB`,
    empty.length === 0
      ? null
      : empty.length === 1
        ? `${empty[0]?.name} is empty`
        : `${count(empty.length, "file", "files")} are empty`,
    twice.length === 0
      ? null
      : twice.length === 1
        ? `${twice[0]?.name} is already attached`
        : `${count(twice.length, "file", "files")} are already attached`,
  ].filter((problem) => problem !== null);
  if (incoming.files.length === 0 && incoming.folders.length > 0) {
    return { accepted, notice: `${incoming.folders.join(", ")} has no files to add.` };
  }
  if (problems.length === 0) return { accepted, notice: null };
  // A colon, not a full stop, leads into the reasons: they can start with
  // a file name, which must keep its own case.
  const lead =
    accepted.length === 0
      ? "Nothing added"
      : `Added ${accepted.length} of ${incoming.files.length}${incoming.truncated === true ? "+" : ""}`;
  return { accepted, notice: `${lead}: ${problems.join("; ")}.` };
}

// Entries are told apart by their own flags: not every browser exposes
// the entry interfaces as globals, so `instanceof` would throw there.
function isFolderEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory;
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile;
}

/** Every file entry under a dropped folder, depth first. Hidden entries
 * (`.DS_Store`, `.git`) are skipped; past `budget` entries the walk stops. */
async function filesInFolder(
  folder: FileSystemDirectoryEntry,
  budget: { remaining: number; truncated: boolean },
): Promise<File[]> {
  const reader = folder.createReader();
  const entries: FileSystemEntry[] = [];
  // readEntries hands back a batch at a time until it returns none.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    entries.push(...batch);
  }
  const files: File[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    budget.remaining -= 1;
    if (isFileEntry(entry)) {
      files.push(await new Promise<File>((resolve, reject) => entry.file(resolve, reject)));
    } else if (isFolderEntry(entry)) {
      files.push(...(await filesInFolder(entry, budget)));
    }
  }
  return files;
}

/** The files in a drop. A dropped folder shows up in `files` as one
 * nameless-typed entry the browser can't read, so its entries are walked
 * instead. The entries must be taken while the drop event is live. */
function readDrop(data: DataTransfer): Promise<IncomingFiles> {
  const entries = [...data.items].flatMap((item) => {
    if (item.kind !== "file") return [];
    const entry = item.webkitGetAsEntry();
    const file = item.getAsFile();
    return [{ entry, file }];
  });
  return (async () => {
    const files: File[] = [];
    const folders: string[] = [];
    const budget = { remaining: MAX_FOLDER_ENTRIES, truncated: false };
    for (const { entry, file } of entries) {
      if (entry !== null && isFolderEntry(entry)) {
        folders.push(entry.name);
        files.push(...(await filesInFolder(entry, budget)));
      } else if (file !== null) {
        files.push(file);
      }
    }
    return budget.truncated ? { files, folders, truncated: true } : { files, folders };
  })();
}

/** What pointing at an attachment shows: the image at a readable size, or
 * the first lines of a text file, with its name and size. */
function AttachmentPreview({ attachment }: { readonly attachment: Attachment }) {
  const kind = mediaKindOf(attachment.mediaType, attachment.name);
  const url = attachment.previewUrl;
  let face: ReactNode = null;
  if (kind === "image" && url !== undefined) face = <img src={url} alt="" />;
  else if (kind === "video" && url !== undefined) {
    face = <video src={url} muted playsInline preload="metadata" />;
  } else if (attachment.excerpt !== undefined) {
    face = <span className="cp-file-preview-text">{attachment.excerpt}</span>;
  }
  // Nothing to picture (a PDF, an archive): the card still names the file.
  return (
    <span
      className="cp-file-preview"
      data-bare={face === null ? "true" : undefined}
      aria-hidden="true"
    >
      {face}
      <span className="cp-file-preview-meta">
        <b>{attachment.name}</b>
        <span>{attachment.size}</span>
      </span>
    </span>
  );
}

function RemoveAttachment({
  attachment,
  className,
  onRemove,
}: {
  readonly attachment: Attachment;
  readonly className: string;
  readonly onRemove: ((id: string) => void) | undefined;
}) {
  if (onRemove === undefined) return null;
  return (
    <button
      type="button"
      className={className}
      aria-label={`Remove ${attachment.name}`}
      onClick={() => onRemove(attachment.id)}
    >
      <X aria-hidden="true" />
    </button>
  );
}

/** The body of an attachment: a button handing it to `onOpen`, or without
 * a handler, a focusable span so the hover preview is still reachable from
 * the keyboard. */
function AttachmentBody({
  attachment,
  className,
  onOpen,
  children,
}: {
  readonly attachment: Attachment;
  readonly className: string;
  readonly onOpen: ((id: string) => void) | undefined;
  readonly children: ReactNode;
}) {
  if (onOpen !== undefined) {
    return (
      <button
        type="button"
        className={className}
        aria-label={`Open ${attachment.name}, ${attachment.size}`}
        onClick={() => onOpen(attachment.id)}
      >
        {children}
      </button>
    );
  }
  return (
    <span className={className} tabIndex={0} aria-label={`${attachment.name}, ${attachment.size}`}>
      {children}
    </span>
  );
}

function AttachmentIcon({ attachment }: { readonly attachment: Attachment }) {
  return <MediaIcon kind={mediaKindOf(attachment.mediaType, attachment.name)} />;
}

/** Waiting attachments as a deck tucked behind the box's top edge: it
 * shows how many and what kind at a glance, and fans out into a row, each
 * card removable and previewable, when pointed at or tabbed into. */
function AttachmentStack({
  attachments,
  onOpen,
  onRemove,
  open,
  onShowAll,
}: {
  readonly attachments: readonly Attachment[];
  /** Pinned open: every card laid out in rows, nothing folded away. */
  readonly open: boolean;
  readonly onOpen: ((id: string) => void) | undefined;
  readonly onRemove: ((id: string) => void) | undefined;
  /** Past the deck's few cards, a "+N" card fanned out last opens the rest. */
  readonly onShowAll: () => void;
}) {
  const shown = open ? attachments : attachments.slice(0, STACK_LIMIT);
  const rest = attachments.length - shown.length;
  return (
    <div
      className="cp-stack"
      role="group"
      aria-label={`${attachments.length} attached`}
      data-open={open ? "true" : undefined}
    >
      {shown.map((attachment, index) => {
        const image =
          mediaKindOf(attachment.mediaType, attachment.name) === "image"
            ? attachment.previewUrl
            : undefined;
        return (
          <span key={attachment.id} className="cp-stack-card">
            <AttachmentBody attachment={attachment} className="cp-stack-open" onOpen={onOpen}>
              {image === undefined ? (
                <span className="cp-stack-type">
                  <AttachmentIcon attachment={attachment} />
                  <span>{extensionOf(attachment.name)}</span>
                </span>
              ) : (
                <img src={image} alt="" />
              )}
            </AttachmentBody>
            <span className="cp-stack-name" aria-hidden="true">
              {attachment.name}
            </span>
            {index === shown.length - 1 && attachments.length > 1 ? (
              <span className="cp-stack-count" aria-hidden="true">
                {attachments.length}
              </span>
            ) : null}
            <RemoveAttachment
              attachment={attachment}
              className="cp-stack-remove"
              onRemove={onRemove}
            />
            <AttachmentPreview attachment={attachment} />
          </span>
        );
      })}
      {rest === 0 ? null : (
        <button
          type="button"
          className="cp-stack-card cp-stack-more"
          aria-label={`Show all ${attachments.length} attachments`}
          onClick={onShowAll}
        >
          +{rest}
        </button>
      )}
    </div>
  );
}

/** A picture, video or text full size, over everything. The native modal
 * dialog holds focus and closes on Escape; a click outside the media
 * closes it too, and with more than one item the arrows (keys or buttons)
 * step through the set it was opened from. Focus goes back where it was
 * on close. */
function MediaViewer({
  items,
  index,
  onIndexChange,
  onClose,
}: {
  readonly items: readonly ViewedMedia[];
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const opener = document.activeElement;
    dialog.showModal();
    // showModal focuses the first control (Download); Close is the safer start.
    closeRef.current?.focus();
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  const item = items[index];
  if (item === undefined) return null;
  const many = items.length > 1;
  const step = (delta: number) => onIndexChange((index + delta + items.length) % items.length);
  return (
    <dialog
      ref={dialogRef}
      className="cp-viewer"
      aria-label={item.name}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        // A focused video's own arrows seek; leave them to it.
        if (!many || event.target instanceof HTMLVideoElement) return;
        if (event.key === "ArrowRight") step(1);
        else if (event.key === "ArrowLeft") step(-1);
      }}
    >
      <figure className="cp-viewer-figure">
        {item.kind === "text" ? (
          <pre key={item.name} className="cp-viewer-text">
            {item.text}
          </pre>
        ) : item.kind === "image" ? (
          <img key={item.src} src={item.src} alt={item.name} />
        ) : item.kind === "pdf" ? (
          <iframe key={item.src} className="cp-viewer-pdf" src={item.src} title={item.name} />
        ) : (
          <video key={item.src} src={item.src} controls autoPlay playsInline />
        )}
        <figcaption className="cp-viewer-bar">
          <span className="cp-viewer-name">
            <b>{item.name}</b>
            <span>
              {item.size}
              {many ? ` · ${index + 1} of ${items.length}` : ""}
            </span>
          </span>
          {item.kind === "text" ? null : (
            <a
              className="cp-viewer-btn"
              href={item.src}
              download={item.name}
              aria-label="Download"
              title="Download"
            >
              <DownloadSimple aria-hidden="true" />
            </a>
          )}
          <button
            type="button"
            className="cp-viewer-btn"
            ref={closeRef}
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </figcaption>
      </figure>
      {many ? (
        <>
          <button
            type="button"
            className="cp-viewer-btn cp-viewer-step"
            data-side="previous"
            aria-label="Previous"
            onClick={() => step(-1)}
          >
            <CaretLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            className="cp-viewer-btn cp-viewer-step"
            data-side="next"
            aria-label="Next"
            onClick={() => step(1)}
          >
            <CaretRight aria-hidden="true" />
          </button>
        </>
      ) : null}
    </dialog>
  );
}

/** Accepts files dropped anywhere over its area. While files are held over
 * it, it marks itself so the composer inside lights up to show where they
 * will land; the conversation itself stays fully visible. Whether a drag
 * is over it is UI state, like scroll position; the files go straight to
 * `onFiles`. Without `onFiles` (attachments are off) it ignores drags. */
function DropZone({
  onFiles,
  children,
}: {
  readonly onFiles: ((incoming: IncomingFiles) => void) | undefined;
  readonly children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  // Enter/leave fire for every child crossed; count them to know when the
  // drag has really left.
  const depth = useRef(0);
  const carriesFiles = (event: DragEvent<HTMLDivElement>) =>
    onFiles !== undefined && event.dataTransfer.types.includes("Files");
  return (
    <div
      className="cp-dropzone"
      data-over={over ? "true" : undefined}
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        if (onFiles === undefined) return;
        readDrop(event.dataTransfer)
          .then((incoming) => {
            if (incoming.files.length > 0 || incoming.folders.length > 0) onFiles(incoming);
          })
          .catch((cause: unknown) => {
            reportError(cause, { operation: "chat_prototype_read_drop" });
          });
      }}
    >
      {children}
    </div>
  );
}

type Segment = { readonly text: string; readonly token?: Suggestion };

/** Splits a draft into plain runs and known tokens. A token counts only as
 * a whole word: "@Ada" in "@Ada, can you", not in "@Adam" or "x@Ada". */
function segmentsOf(value: string, tokens: readonly Suggestion[]): readonly Segment[] {
  const longestFirst = [...tokens].sort((a, b) => b.token.length - a.token.length);
  const segments: Segment[] = [];
  let runStart = 0;
  let index = 0;
  while (index < value.length) {
    const wordStart = index === 0 || /\s/.test(value.charAt(index - 1));
    const hit = wordStart
      ? longestFirst.find(
          (token) =>
            value.startsWith(token.token, index) &&
            !/[\w-]/.test(value.charAt(index + token.token.length)),
        )
      : undefined;
    if (hit === undefined) {
      index += 1;
      continue;
    }
    if (index > runStart) segments.push({ text: value.slice(runStart, index) });
    segments.push({ text: hit.token, token: hit });
    index += hit.token.length;
    runStart = index;
  }
  if (runStart < value.length) segments.push({ text: value.slice(runStart) });
  return segments;
}

/** Browsers that size a textarea to its text natively (Chrome, Edge,
 * Brave); the rest measure it after every change. */
const NATIVE_AUTOSIZE = CSS.supports("field-sizing", "content");

type TokenTip = { readonly segment: number; readonly left: number; readonly top: number };

/** The draft's textarea, with known tokens in the accent colour. A mirror
 * under the textarea holds the same text, wrapped the same way, and only
 * the mirror's letters show: the colour sits exactly under what is typed,
 * while caret, selection and input stay the textarea's own. Pointing at a
 * token shows its description. */
function PromptInput({
  inputRef,
  value,
  placeholder,
  disabled,
  tokens,
  onValueChange,
  onPaste,
  onKeyDown,
}: {
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly value: string;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly tokens: readonly Suggestion[];
  readonly onValueChange: (value: string) => void;
  readonly onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<TokenTip | null>(null);
  const segments = useMemo(() => segmentsOf(value, tokens), [value, tokens]);

  // Grow with the text up to the CSS max-height; the mirror keeps pace.
  // Where the browser sizes the field itself (`field-sizing: content`)
  // nothing is measured. Elsewhere the height is reset and read back, which
  // forces a layout of the whole page: in a long conversation that is the
  // cost of every keystroke, so it stays the fallback.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    if (!NATIVE_AUTOSIZE) {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    }
    if (mirrorRef.current !== null) mirrorRef.current.scrollTop = input.scrollTop;
  }, [value, inputRef]);

  const pointAt = (x: number, y: number) => {
    const wrap = wrapRef.current;
    const mirror = mirrorRef.current;
    if (wrap === null || mirror === null) return;
    const box = wrap.getBoundingClientRect();
    for (const mark of mirror.querySelectorAll<HTMLElement>("[data-segment]")) {
      // A token can wrap onto two lines: one rect per line.
      for (const rect of mark.getClientRects()) {
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
        const segment = Number(mark.dataset.segment);
        setTip((current) =>
          current?.segment === segment
            ? current
            : { segment, left: rect.left - box.left, top: rect.top - box.top },
        );
        return;
      }
    }
    setTip((current) => (current === null ? current : null));
  };
  const tipped = tip === null ? undefined : segments[tip.segment]?.token;

  return (
    <div className="cp-input" ref={wrapRef}>
      <div ref={mirrorRef} className="chat-composer-input cp-input-mirror" aria-hidden="true">
        {segments.map((segment, index) =>
          segment.token === undefined ? (
            segment.text
          ) : (
            <mark key={index} className="cp-token" data-segment={index}>
              {segment.text}
            </mark>
          ),
        )}
        {/* A trailing newline only takes up its line with something after it. */}
        {"\u200B"}
      </div>
      <textarea
        ref={inputRef}
        className="chat-composer-input cp-input-field"
        rows={1}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        onChange={(event) => {
          setTip(null);
          onValueChange(event.target.value);
        }}
        onScroll={(event) => {
          if (mirrorRef.current !== null)
            mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
          setTip(null);
        }}
        onPointerMove={(event) => pointAt(event.clientX, event.clientY)}
        onPointerLeave={() => setTip(null)}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
      />
      {tip === null || tipped?.detail === undefined ? null : (
        <span className="cp-token-tip" role="tooltip" style={{ left: tip.left, top: tip.top }}>
          <b>{tipped.token}</b>
          <span>{tipped.detail}</span>
        </span>
      )}
    </div>
  );
}

/** Model, provider and how hard it thinks, in one menu. The trigger reads
 * "Sonnet 5.5 · Medium"; a model that doesn't reason drops the level. */
function ModelPicker({
  models,
  levels,
  choice,
  disabled,
  onChange,
}: {
  readonly models: readonly ModelOption[];
  readonly levels: readonly ReasoningLevel[];
  readonly choice: ModelChoice;
  readonly disabled: boolean;
  readonly onChange: (choice: ModelChoice) => void;
}) {
  const model = models.find((option) => option.id === choice.modelId) ?? models[0];
  if (model === undefined) return null;
  const level = model.reasons
    ? levels.find((option) => option.id === choice.reasoningId)
    : undefined;
  const providers = [...new Set(models.map((option) => option.provider))];
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="cp-picker"
          disabled={disabled}
          aria-label={`Model: ${model.name}${level === undefined ? "" : `, ${level.label} reasoning`}`}
        >
          <span>{model.short}</span>
          {level === undefined ? null : <span className="cp-picker-sub">· {level.label}</span>}
          <CaretDown aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent side="top" align="end" sideOffset={8} className="cp-picker-menu">
        {providers.map((provider) => (
          <MenuGroup key={provider}>
            <MenuLabel className="cp-picker-label">{provider}</MenuLabel>
            {models
              .filter((option) => option.provider === provider)
              .map((option) => (
                <MenuItem
                  key={option.id}
                  className="cp-picker-item"
                  onSelect={() => onChange({ ...choice, modelId: option.id })}
                >
                  <span className="cp-picker-text">
                    <b>{option.name}</b>
                    <span>{option.detail}</span>
                  </span>
                  {option.id === model.id ? <Check aria-hidden="true" /> : null}
                </MenuItem>
              ))}
          </MenuGroup>
        ))}
        {model.reasons ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuLabel className="cp-picker-label">Reasoning</MenuLabel>
              {levels.map((option) => (
                <MenuItem
                  key={option.id}
                  className="cp-picker-item"
                  onSelect={() => onChange({ ...choice, reasoningId: option.id })}
                >
                  <span className="cp-picker-text">
                    <b>{option.label}</b>
                    <span>{option.detail}</span>
                  </span>
                  {option.id === level?.id ? <Check aria-hidden="true" /> : null}
                </MenuItem>
              ))}
            </MenuGroup>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

/** How the agent works this turn. Labels and descriptions are the modes'
 * own strings; the trigger shows the current mode's label. */
function ModePicker({
  modes,
  value,
  disabled,
  onChange,
}: {
  readonly modes: readonly ModeOption[];
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (id: string) => void;
}) {
  const mode = modes.find((option) => option.id === value) ?? modes[0];
  if (mode === undefined) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="cp-picker"
          disabled={disabled}
          aria-label={`Mode: ${mode.label}`}
        >
          <span>{mode.label}</span>
          <CaretDown aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent side="top" align="start" sideOffset={8} className="cp-picker-menu">
        {modes.map((option) => (
          <MenuItem key={option.id} className="cp-picker-item" onSelect={() => onChange(option.id)}>
            <span className="cp-picker-text">
              <b>{option.label}</b>
              <span>{option.detail}</span>
            </span>
            {option.id === mode.id ? <Check aria-hidden="true" /> : null}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

type ComposerProps = {
  readonly capabilities: ComposerCapabilities;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onStop?: () => void;
  readonly status: ComposerStatus;
  readonly placeholder: string;
  /** Small print under the box, e.g. that answers can be wrong. */
  readonly note?: string;
  readonly disabled?: boolean;
  readonly menuOpen: boolean;
  readonly onMenuOpenChange: (open: boolean) => void;
  readonly attachments: readonly Attachment[];
  /** Files from the picker or pasted from the clipboard. */
  readonly onAddFiles: (files: readonly File[]) => void;
  /** A paste long enough to read as a document rather than a message. */
  readonly onPasteText?: (text: string) => void;
  readonly onRemoveAttachment?: (id: string) => void;
  /** Clears every attachment at once; offered while the stack is expanded. */
  readonly onRemoveAllAttachments?: () => void;
  /** An attachment was clicked: open or preview it, as the host sees fit. */
  readonly onOpenAttachment?: (id: string) => void;
  /** Why something just added was turned away (too big, too many). */
  readonly notice: string | null;
  readonly context: ComposerContext | null;
  readonly onClearContext?: () => void;
  /** Already filtered to what the `@` or `/` being typed matches; empty hides the list. */
  readonly suggestions: readonly Suggestion[];
  readonly suggestionIndex: number;
  readonly onSuggestionIndexChange: (index: number) => void;
  readonly onPickSuggestion: (option: Suggestion) => void;
  /** Every token that highlights in the text, typed or picked. */
  readonly tokens: readonly Suggestion[];
  /** Starts a fresh `@` or `/` at the end of the draft. */
  readonly onStartToken: (prefix: "@" | "/") => void;
  readonly onVoice: () => void;
  readonly models: readonly ModelOption[];
  readonly reasoningLevels: readonly ReasoningLevel[];
  readonly modelChoice: ModelChoice;
  readonly onModelChoiceChange: (choice: ModelChoice) => void;
  readonly modes: readonly ModeOption[];
  readonly modeId: string;
  readonly onModeChange: (id: string) => void;
};

/** The live composer's box and styles, with every capability switchable.
 * With a model or mode picker on, the text gets its own row and the
 * controls sit under it; otherwise it is the live single row. Attachments,
 * the reply context, notices and the `@`/`/` list float above the box. */
function Composer({
  capabilities,
  value,
  onValueChange,
  onSubmit,
  onStop,
  status,
  placeholder,
  note,
  disabled = false,
  menuOpen,
  onMenuOpenChange,
  attachments,
  onAddFiles,
  onPasteText,
  onRemoveAttachment,
  onRemoveAllAttachments,
  onOpenAttachment,
  notice,
  context,
  onClearContext,
  suggestions,
  suggestionIndex,
  onSuggestionIndexChange,
  onPickSuggestion,
  tokens,
  onStartToken,
  onVoice,
  models,
  reasoningLevels,
  modelChoice,
  onModelChoiceChange,
  modes,
  modeId,
  onModeChange,
}: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const plusRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const can = capabilities;
  const canSend =
    (value.trim() !== "" || attachments.length > 0) && status === "ready" && !disabled;
  const listOpen = suggestions.length > 0;
  const mode = can.mode ? modes.find((option) => option.id === modeId) : undefined;
  const stacked = can.mode || can.model;

  // Any press outside the `+` menu closes it.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (event.target instanceof Node && plusRef.current?.contains(event.target) === true) return;
      onMenuOpenChange(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen, onMenuOpenChange]);

  const held = context !== null || attachments.length > 0;
  const floating = listOpen || held || notice !== null;
  // Past the deck's few cards, "+N" pins the stack open to show them all.
  const [showAll, setShowAll] = useState(false);
  const many = attachments.length > STACK_LIMIT;
  const expanded = showAll && many;
  useEffect(() => {
    if (!many) setShowAll(false);
  }, [many]);

  // The conversation keeps clear of what floats over its bottom edge: the
  // tray and any notice are measured, and the drop zone (or panel) around
  // the composer gets their height as `--cp-held`.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const host = root.closest(".cp-dropzone, .cp-panel");
    const box = root.querySelector(".chat-composer-box");
    if (!(host instanceof HTMLElement) || box === null) return;
    const measure = () => {
      const tops = [...root.querySelectorAll(".cp-composer-tray, .cp-composer-notice")].map(
        (element) => element.getBoundingClientRect().top,
      );
      const intrusion = tops.length === 0 ? 0 : box.getBoundingClientRect().top - Math.min(...tops);
      host.style.setProperty("--cp-held", `${Math.max(0, Math.round(intrusion))}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const element of root.querySelectorAll(".cp-composer-float, .chat-composer-box")) {
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
      host.style.removeProperty("--cp-held");
    };
  }, [held, notice, expanded, attachments.length]);

  const plus =
    can.files || can.mentions || can.commands ? (
      <div
        className="chat-composer-plus"
        ref={plusRef}
        // Focus stays on the `+` button while the menu is open, so Escape
        // is heard here rather than on the menu.
        onKeyDown={(event) => {
          if (event.key === "Escape" && menuOpen) {
            event.stopPropagation();
            onMenuOpenChange(false);
          }
        }}
      >
        <button
          type="button"
          className="chat-composer-btn"
          aria-label="Add"
          title="Add"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={disabled}
          onClick={() => onMenuOpenChange(!menuOpen)}
        >
          <Plus aria-hidden="true" />
        </button>
        {menuOpen ? (
          <div className="chat-composer-menu" role="menu">
            {can.files ? (
              <button
                type="button"
                role="menuitem"
                className="chat-composer-menu-item"
                onClick={() => {
                  onMenuOpenChange(false);
                  fileRef.current?.click();
                }}
              >
                <Paperclip aria-hidden="true" />
                Add files or photos
              </button>
            ) : null}
            {can.mentions ? (
              <button
                type="button"
                role="menuitem"
                className="chat-composer-menu-item"
                onClick={() => {
                  onMenuOpenChange(false);
                  onStartToken("@");
                  inputRef.current?.focus();
                }}
              >
                <AtSign aria-hidden="true" />
                Mention a worker
              </button>
            ) : null}
            {can.commands ? (
              <button
                type="button"
                role="menuitem"
                className="chat-composer-menu-item"
                onClick={() => {
                  onMenuOpenChange(false);
                  onStartToken("/");
                  inputRef.current?.focus();
                }}
              >
                <SquareSlash aria-hidden="true" />
                Use a command
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    ) : null;

  const input = (
    <PromptInput
      inputRef={inputRef}
      value={value}
      placeholder={mode?.placeholder ?? placeholder}
      disabled={disabled}
      tokens={tokens}
      onValueChange={onValueChange}
      onPaste={(event) => {
        // Screenshots and copied files attach instead of pasting as text.
        const files = can.files
          ? [...event.clipboardData.items].flatMap((item) => {
              if (item.kind !== "file") return [];
              const file = item.getAsFile();
              return file === null ? [] : [file];
            })
          : [];
        if (files.length > 0) {
          event.preventDefault();
          onAddFiles(files);
          return;
        }
        const pasted = event.clipboardData.getData("text/plain");
        if (can.files && onPasteText !== undefined && pasted.length >= LONG_PASTE_CHARS) {
          event.preventDefault();
          onPasteText(pasted);
        }
      }}
      onKeyDown={(event) => {
        // Enter confirms an IME composition; it must not send or pick.
        if (event.nativeEvent.isComposing) return;
        if (listOpen) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            onSuggestionIndexChange(
              (suggestionIndex + step + suggestions.length) % suggestions.length,
            );
            return;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            const option = suggestions[suggestionIndex];
            if (option !== undefined) {
              event.preventDefault();
              onPickSuggestion(option);
              return;
            }
          }
        }
        if (event.key !== "Enter" || event.shiftKey) return;
        event.preventDefault();
        if (!event.repeat && canSend) onSubmit();
      }}
    />
  );

  const voice = can.voice ? (
    <button
      type="button"
      className="chat-composer-btn chat-composer-voice"
      aria-label="Voice mode"
      title="Voice mode"
      disabled={disabled}
      onClick={onVoice}
    >
      <AudioLines aria-hidden="true" />
    </button>
  ) : null;

  const send =
    status === "streaming" && onStop !== undefined ? (
      <button
        type="button"
        className="chat-composer-send"
        aria-label="Stop"
        title="Stop"
        onClick={onStop}
      >
        <Stop aria-hidden="true" />
      </button>
    ) : (
      <button
        type="button"
        className="chat-composer-send"
        aria-label={status === "submitting" ? "Sending…" : "Send"}
        title={status === "submitting" ? "Sending…" : "Send"}
        disabled={!canSend}
        onClick={onSubmit}
      >
        {status === "submitting" ? (
          <CircleNotch className="chat-composer-send-spinner" aria-hidden="true" />
        ) : (
          <ArrowUp aria-hidden="true" />
        )}
      </button>
    );

  return (
    <div className="chat-composer cp-composer" ref={rootRef}>
      {floating ? (
        <div
          className="cp-composer-float"
          data-held={held || notice !== null ? "true" : undefined}
          data-expanded={expanded ? "true" : undefined}
        >
          {listOpen ? (
            // The live composer's mention list, markup and classes alike.
            <ul
              className="chat-composer-mentions"
              role="listbox"
              aria-label={suggestions[0]?.kind === "command" ? "Commands" : "Mention a worker"}
            >
              {suggestions.map((option, index) => (
                <li key={option.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === suggestionIndex}
                    data-active={index === suggestionIndex ? "" : undefined}
                    onMouseEnter={() => onSuggestionIndexChange(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onPickSuggestion(option);
                    }}
                  >
                    <span className="chat-composer-mention-name">{option.token}</span>
                    {option.detail === undefined ? null : (
                      <span className="chat-composer-mention-detail">{option.detail}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {notice === null ? null : (
            <p className="cp-composer-notice" role="status">
              <Warning aria-hidden="true" /> {notice}
            </p>
          )}
          {held ? (
            <div className="cp-composer-tray">
              {context === null ? null : (
                <span className="cp-chip">
                  <ArrowBendUpLeft aria-hidden="true" />
                  <span>
                    <b>{context.label}</b> {context.detail}
                  </span>
                  {onClearContext === undefined ? null : (
                    <button type="button" aria-label="Clear" onClick={onClearContext}>
                      <X aria-hidden="true" />
                    </button>
                  )}
                </span>
              )}
              {attachments.length === 0 ? null : (
                <AttachmentStack
                  attachments={attachments}
                  open={expanded}
                  onOpen={onOpenAttachment}
                  onRemove={onRemoveAttachment}
                  onShowAll={() => setShowAll(true)}
                />
              )}
              {expanded ? (
                <span className="cp-file-more-actions">
                  <button type="button" className="cp-file-more" onClick={() => setShowAll(false)}>
                    Show less
                  </button>
                  {onRemoveAllAttachments === undefined ? null : (
                    <button
                      type="button"
                      className="cp-file-more"
                      onClick={() => {
                        setShowAll(false);
                        onRemoveAllAttachments();
                      }}
                    >
                      Remove all
                    </button>
                  )}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="chat-composer-box cp-box" data-layout={stacked ? "stacked" : "row"}>
        {can.files ? (
          <>
            <p className="cp-drop-hint" aria-hidden="true">
              <Paperclip /> Drop to attach · up to {MAX_FILE_MB} MB each
            </p>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                // Cleared so picking the same file again still fires.
                event.target.value = "";
                if (files.length > 0) onAddFiles(files);
              }}
            />
          </>
        ) : null}
        {stacked ? (
          <>
            {input}
            <div className="cp-toolbar">
              {plus}
              {can.mode ? (
                <ModePicker
                  modes={modes}
                  value={modeId}
                  disabled={disabled}
                  onChange={onModeChange}
                />
              ) : null}
              <div className="cp-toolbar-end">
                {can.model ? (
                  <ModelPicker
                    models={models}
                    levels={reasoningLevels}
                    choice={modelChoice}
                    disabled={disabled}
                    onChange={onModelChoiceChange}
                  />
                ) : null}
                {voice}
                {send}
              </div>
            </div>
          </>
        ) : (
          <>
            {plus}
            {input}
            {voice}
            {send}
          </>
        )}
      </div>
      {note === undefined ? null : <p className="cp-composer-note">{note}</p>}
    </div>
  );
}

/** A person-chosen panel width, or `null` for the panel's own default. */
type PanelSizing = {
  readonly width: number | null;
  readonly onWidthChange: (width: number | null) => void;
};

const PANEL_MIN = 320;
/** The conversation never gets narrower than this while a panel is open. */
const MAIN_MIN = 440;
const SNAP_PX = 12;
const KEY_STEP = 16;

function defaultPanelWidth(size: "narrow" | "wide"): number {
  return size === "narrow"
    ? 400
    : Math.round(Math.min(760, Math.max(480, window.innerWidth * 0.46)));
}

function panelBounds(panel: HTMLElement): { readonly min: number; readonly max: number } {
  const total = panel.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
  return { min: PANEL_MIN, max: Math.max(PANEL_MIN, Math.round(total - MAIN_MIN)) };
}

/** The panel's rendered width and how wide it may go, as measured. */
type PanelMetrics = { readonly width: number; readonly max: number };

/** The panel's left edge: a 1px line that darkens on hover and turns
 * light orange while held. A drag writes the width straight to the panel element, so
 * nothing else re-renders mid-drag; the final width is committed once on
 * release, snapping to the default when close. Arrow keys nudge it (Shift
 * for bigger steps), Home/End jump to the limits, and a double-click or
 * Enter puts it back to the default. */
function PanelResizeHandle({
  panelRef,
  metrics,
  remeasure,
  label,
  size,
  onWidthChange,
}: {
  readonly panelRef: RefObject<HTMLElement | null>;
  readonly metrics: PanelMetrics | null;
  /** Re-reads the panel's size right after a change, so ARIA never lags. */
  readonly remeasure: () => void;
  readonly label: string;
  readonly size: "narrow" | "wide";
  readonly onWidthChange: PanelSizing["onWidthChange"];
}) {
  const handleRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const fallback = defaultPanelWidth(size);
  const current = metrics?.width ?? fallback;

  const commit = (next: number | null) => {
    const panel = panelRef.current;
    if (panel === null) return;
    if (next === null) {
      panel.style.removeProperty("--cp-panel-w");
      remeasure();
      onWidthChange(null);
      return;
    }
    const { min, max } = panelBounds(panel);
    const clamped = Math.round(Math.min(Math.max(next, min), max));
    panel.style.setProperty("--cp-panel-w", `${clamped}px`);
    remeasure();
    onWidthChange(Math.abs(clamped - fallback) < 1 ? null : clamped);
  };

  return (
    <div
      ref={handleRef}
      className="cp-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={PANEL_MIN}
      aria-valuemax={metrics?.max ?? PANEL_MIN}
      aria-valuenow={current}
      tabIndex={0}
      data-dragging={dragging ? "true" : undefined}
      onPointerDown={(event) => {
        const panel = panelRef.current;
        const handle = handleRef.current;
        if (event.button !== 0 || panel === null || handle === null) return;
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        const startX = event.clientX;
        const startWidth = panel.getBoundingClientRect().width;
        const { min, max } = panelBounds(panel);
        let latest = startWidth;
        let frame = 0;
        document.documentElement.dataset.cpResizing = "true";
        setDragging(true);
        const move = (moveEvent: PointerEvent) => {
          // The panel sits on the right, so dragging left widens it.
          let next = Math.min(Math.max(startWidth + (startX - moveEvent.clientX), min), max);
          if (Math.abs(next - fallback) < SNAP_PX) next = fallback;
          latest = next;
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            panel.style.setProperty("--cp-panel-w", `${next}px`);
          });
        };
        const end = () => {
          cancelAnimationFrame(frame);
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", end);
          handle.removeEventListener("pointercancel", end);
          delete document.documentElement.dataset.cpResizing;
          setDragging(false);
          commit(latest);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
      }}
      onDoubleClick={() => commit(null)}
      onKeyDown={(event) => {
        const panel = panelRef.current;
        if (panel === null) return;
        const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
        const { min, max } = panelBounds(panel);
        const keyed: Record<string, number | null> = {
          ArrowLeft: current + step,
          ArrowRight: current - step,
          Home: min,
          End: max,
          Enter: null,
        };
        if (!(event.key in keyed)) return;
        event.preventDefault();
        commit(keyed[event.key] ?? null);
      }}
    >
      <span className="cp-resize-line" aria-hidden="true" />
    </div>
  );
}

function SidePanel({
  label,
  size,
  width,
  onWidthChange,
  header,
  footer,
  onDropFiles,
  children,
}: {
  readonly label: string;
  /** Threads read like chat; documents need a page's width. */
  readonly size: "narrow" | "wide";
  readonly header: ReactNode;
  readonly footer?: ReactNode;
  /** Makes the body a drop target for the panel's own composer. */
  readonly onDropFiles: ((incoming: IncomingFiles) => void) | undefined;
  readonly children: ReactNode;
} & PanelSizing) {
  const panelRef = useRef<HTMLElement | null>(null);
  const [metrics, setMetrics] = useState<PanelMetrics | null>(null);
  // The width lives in a CSS variable so the narrow-screen overlay rule
  // can still override it.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    if (width === null) panel.style.removeProperty("--cp-panel-w");
    else panel.style.setProperty("--cp-panel-w", `${width}px`);
  }, [width]);
  // Measured here, not in the handle: a child's layout effect runs before
  // this element's ref is attached. Kept current through drags and window
  // resizes, so the handle's ARIA values always match what is on screen.
  const measure = useCallback(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    setMetrics({
      width: Math.round(panel.getBoundingClientRect().width),
      max: panelBounds(panel).max,
    });
  }, []);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    if (panel.parentElement !== null) observer.observe(panel.parentElement);
    return () => observer.disconnect();
  }, [measure]);
  return (
    <aside ref={panelRef} className="cp-panel" data-size={size} aria-label={label}>
      <PanelResizeHandle
        panelRef={panelRef}
        metrics={metrics}
        remeasure={measure}
        label={`Resize ${label.toLowerCase()} panel`}
        size={size}
        onWidthChange={onWidthChange}
      />
      <header className="cp-panel-head">{header}</header>
      <DropZone onFiles={onDropFiles}>
        <div className="cp-panel-body">{children}</div>
        {footer === undefined ? null : <footer className="cp-panel-foot">{footer}</footer>}
      </DropZone>
    </aside>
  );
}

/** One control in a panel's header row, beside Close: an icon button
 * (optionally on/off), or a menu of items. A panel's row is empty unless
 * the surface passes some. */
type PanelAction =
  | {
      readonly kind: "button";
      readonly id: string;
      readonly label: string;
      readonly icon: ReactNode;
      /** Set for a toggle: whether it is on. */
      readonly pressed?: boolean;
      readonly onSelect: () => void;
    }
  | {
      readonly kind: "menu";
      readonly id: string;
      readonly label: string;
      readonly icon: ReactNode;
      readonly items: readonly PanelMenuItem[];
    };

type PanelMenuItem = {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  /** Destructive: drawn in the danger colour. */
  readonly danger?: boolean;
  readonly onSelect: () => void;
};

const NO_PANEL_ACTIONS: readonly PanelAction[] = [];

/** A thread panel widened from its header lands at this width. */
const THREAD_WIDE = 640;

/** A panel's header controls, then a hairline, then Close. */
function PanelHeaderActions({
  label,
  actions,
  onClose,
}: {
  readonly label: string;
  readonly actions: readonly PanelAction[];
  readonly onClose: () => void;
}) {
  return (
    <div className="cp-panel-actions" role="toolbar" aria-label={`${label} actions`}>
      {actions.map((action) =>
        action.kind === "button" ? (
          <button
            key={action.id}
            type="button"
            className="cp-icon-btn cp-tip"
            data-tip={action.label}
            aria-label={action.label}
            aria-pressed={action.pressed}
            onClick={action.onSelect}
          >
            {action.icon}
          </button>
        ) : (
          <Menu key={action.id}>
            <MenuTrigger asChild>
              <button
                type="button"
                className="cp-icon-btn cp-tip"
                data-tip={action.label}
                aria-label={action.label}
              >
                {action.icon}
              </button>
            </MenuTrigger>
            <MenuContent align="end" sideOffset={4} className="cp-more-menu">
              {action.items.map((item) => (
                <MenuItem
                  key={item.id}
                  onSelect={item.onSelect}
                  data-danger={item.danger === true ? "true" : undefined}
                >
                  {item.icon}
                  {item.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        ),
      )}
      {actions.length === 0 ? null : <span className="cp-panel-sep" aria-hidden="true" />}
      <PanelClose onClose={onClose} />
    </div>
  );
}

function PanelClose({ onClose }: { readonly onClose: () => void }) {
  return (
    <button
      type="button"
      className="cp-icon-btn cp-tip"
      data-tip="Close"
      aria-label="Close"
      onClick={onClose}
    >
      <X aria-hidden="true" />
    </button>
  );
}

function ThreadPanel({
  parent,
  replies,
  participants,
  artifacts,
  meId,
  copiedId,
  actions = NO_ACTIONS,
  handlers,
  composer,
  working,
  awaitingFirstContent: waiting,
  sizing,
  onDropFiles,
  headerActions = NO_PANEL_ACTIONS,
  avatars = true,
  names = true,
  onClose,
}: {
  readonly parent: ChatMessage;
  readonly replies: readonly ChatMessage[];
  readonly participants: ReadonlyMap<string, Participant>;
  readonly artifacts: ReadonlyMap<string, Artifact>;
  readonly meId: string;
  readonly copiedId: string | null;
  /** Actions under agent replies; the reply action never shows in a thread. */
  readonly actions?: readonly MessageActionId[];
  readonly handlers: MessageHandlers;
  readonly composer: ReactNode;
  readonly working: boolean;
  /** Show the working label: a reply is on its way but nothing of it is visible. */
  readonly awaitingFirstContent: boolean;
  readonly sizing: PanelSizing;
  readonly onDropFiles: ((incoming: IncomingFiles) => void) | undefined;
  /** Controls in the header row beside Close; none by default. */
  readonly headerActions?: readonly PanelAction[];
  /** The avatar column beside others' replies. */
  readonly avatars?: boolean;
  /** The name, role and time over others' replies. */
  readonly names?: boolean;
  readonly onClose: () => void;
}) {
  const latestId = latestAgentMessageId([parent, ...replies], participants);
  const row = (message: ChatMessage) => (
    <MessageRow
      key={message.id}
      message={message}
      author={participants.get(message.authorId) ?? UNKNOWN_AUTHOR}
      own={message.authorId === meId}
      variant="thread"
      {...rowScope(message, artifacts, null, false)}
      threadOpen={false}
      copied={copiedId === message.id}
      latest={latestId === message.id}
      actions={actions}
      avatars={avatars}
      names={names}
      handlers={handlers}
    />
  );
  const sentReply = lastSentBy(replies, meId);
  return (
    <SidePanel
      label="Thread"
      size="narrow"
      {...sizing}
      onDropFiles={onDropFiles}
      header={
        <>
          <div className="cp-panel-title">
            <b>Thread</b>
          </div>
          <PanelHeaderActions label="Thread" actions={headerActions} onClose={onClose} />
        </>
      }
      footer={composer}
    >
      <Conversation
        label="Thread"
        working={working}
        {...(sentReply === undefined ? {} : { sentId: sentReply })}
      >
        {row(parent)}
        {replies.map(row)}
        {waiting ? <Working /> : null}
      </Conversation>
    </SidePanel>
  );
}

/** A document artifact: the chat's markdown, in page typography. */
function DocumentView({ markdown }: { readonly markdown: string }) {
  return (
    <article className="cp-doc">
      <Prose markdown={markdown} />
    </article>
  );
}

function CodeView({ code }: { readonly code: string }) {
  return (
    <pre className="cp-code">
      {code.split("\n").map((line, index) => (
        <span key={index} className="cp-code-line">
          <span className="cp-code-gutter" aria-hidden="true">
            {index + 1}
          </span>
          <code>{line === "" ? " " : line}</code>
        </span>
      ))}
    </pre>
  );
}

function ArtifactPanel({
  artifact,
  version,
  participants,
  copied,
  onSelectVersion,
  onCopy,
  onDownload,
  onAskForChanges,
  sizing,
  onClose,
}: {
  readonly artifact: Artifact;
  readonly version: ArtifactVersion;
  readonly participants: ReadonlyMap<string, Participant>;
  readonly copied: boolean;
  readonly onSelectVersion: (version: number) => void;
  readonly onCopy: () => void;
  readonly onDownload: () => void;
  readonly onAskForChanges: () => void;
  readonly sizing: PanelSizing;
  readonly onClose: () => void;
}) {
  const author = participants.get(version.authorId);
  const latest = latestVersion(artifact);
  return (
    <SidePanel
      label={artifact.title}
      size="wide"
      onDropFiles={undefined}
      {...sizing}
      header={
        <>
          <span className="cp-tile" data-kind={artifact.kind}>
            <KindIcon kind={artifact.kind} />
          </span>
          <div className="cp-panel-title">
            <b>{artifact.title}</b>
            <span>
              {KIND_LABEL[artifact.kind]} · {artifactMeta(artifact, version)}
            </span>
          </div>
          {artifact.versions.length > 1 ? (
            <div className="cp-versions" role="tablist" aria-label="Versions">
              {artifact.versions.map((candidate) => (
                <button
                  key={candidate.version}
                  type="button"
                  role="tab"
                  aria-selected={candidate.version === version.version}
                  onClick={() => onSelectVersion(candidate.version)}
                >
                  v{candidate.version}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            className="cp-icon-btn cp-tip"
            data-tip={copied ? "Copied" : "Copy"}
            aria-label="Copy"
            onClick={onCopy}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="cp-icon-btn cp-tip"
            data-tip="Download"
            aria-label="Download"
            onClick={onDownload}
          >
            <DownloadSimple aria-hidden="true" />
          </button>
          <PanelClose onClose={onClose} />
        </>
      }
      footer={
        <div className="cp-artifact-foot">
          <span>
            {version.version === latest ? "Latest" : `v${version.version} of ${latest}`} ·{" "}
            {author?.name ?? "Unknown"} · {relativeTime(version.at)}
            <span className="cp-artifact-note"> — {version.note}</span>
          </span>
          <button type="button" className="cp-btn" onClick={onAskForChanges}>
            Ask for changes
          </button>
        </div>
      }
    >
      <div className="cp-artifact-body" data-kind={artifact.kind}>
        {artifact.kind === "doc" ? <DocumentView markdown={version.content} /> : null}
        {artifact.kind === "sheet" ? (
          <CsvTable text={version.content} caption={artifact.title} />
        ) : null}
        {artifact.kind === "code" ? <CodeView code={version.content} /> : null}
      </div>
    </SidePanel>
  );
}

/** Main column plus at most one side panel. With no conversation yet it
 * is the empty state alone: no pill, the composer under the title. */
function ChatLayout({
  pill,
  conversation,
  composer,
  panel,
  onDropFiles,
}: {
  readonly pill: ReactNode;
  /** `null` while there is nothing to show yet. */
  readonly conversation: ReactNode;
  readonly composer: ReactNode;
  readonly panel: ReactNode;
  /** Files dropped anywhere on the main column join the next message. */
  readonly onDropFiles: ((incoming: IncomingFiles) => void) | undefined;
}) {
  return (
    <div className="cp-layout" data-panel={panel === null ? undefined : "open"}>
      <section className="cp-surface">
        <DropZone onFiles={onDropFiles}>
          {conversation === null ? (
            <EmptyConversation composer={composer} />
          ) : (
            <>
              {pill}
              {conversation}
              <div className="cp-composer-dock">{composer}</div>
            </>
          )}
        </DropZone>
      </section>
      {panel}
    </div>
  );
}

const ME: Participant = { id: "p-me", kind: "person", name: "Alex Rivera" };
const SAM: Participant = { id: "p-sam", kind: "person", name: "Sam Chen" };
const ADA: Participant = {
  id: "a-ada",
  kind: "agent",
  name: "Ada",
  role: "Worker",
};
const LINUS: Participant = { id: "a-linus", kind: "agent", name: "Linus", role: "Code review" };
/** An agent the worker created for one job, with only the access it needs. */
const SCOUT: Participant = {
  id: "a-scout",
  kind: "agent",
  name: "Pricing scout",
  role: "Browserbase · Exa",
};

const PARTICIPANTS: ReadonlyMap<string, Participant> = new Map(
  [ME, SAM, ADA, LINUS, SCOUT].map((participant) => [participant.id, participant]),
);

const AGENTS: readonly Participant[] = [ADA, LINUS, SCOUT];

const MENTIONABLE: readonly Suggestion[] = AGENTS.map((agent) => ({
  id: agent.id,
  kind: "mention",
  token: `@${agent.name}`,
  ...(agent.role === undefined ? {} : { detail: agent.role }),
}));

const COMMANDS: readonly Suggestion[] = [
  { id: "c-brief", kind: "command", token: "/brief", detail: "Run the Morning brief now" },
  {
    id: "c-triage",
    kind: "command",
    token: "/triage",
    detail: "Sort unread mail into what needs you and the rest",
  },
  {
    id: "c-pricing",
    kind: "command",
    token: "/pricing",
    detail: "Ask Pricing scout for a fresh check",
  },
  { id: "c-plan", kind: "command", token: "/plan", detail: "Lay out a plan before doing anything" },
  { id: "c-summary", kind: "command", token: "/summary", detail: "Sum up this conversation" },
];

const MODELS: readonly ModelOption[] = [
  {
    id: "claude-sonnet-5-5",
    provider: "Anthropic",
    name: "Claude Sonnet 5.5",
    short: "Sonnet 5.5",
    detail: "Fast and capable, for most work",
    reasons: true,
  },
  {
    id: "claude-opus-5-5",
    provider: "Anthropic",
    name: "Claude Opus 5.5",
    short: "Opus 5.5",
    detail: "Most capable, for hard problems",
    reasons: true,
  },
  {
    id: "claude-haiku-5-5",
    provider: "Anthropic",
    name: "Claude Haiku 5.5",
    short: "Haiku 5.5",
    detail: "Quickest, for small jobs",
    reasons: true,
  },
  {
    id: "ollama-llama-3-3",
    provider: "Ollama · this machine",
    name: "Llama 3.3 70B",
    short: "Llama 3.3",
    detail: "Runs locally; nothing leaves your machine",
    reasons: false,
  },
];

const REASONING_LEVELS: readonly ReasoningLevel[] = [
  { id: "low", label: "Low", detail: "Answers straight away" },
  { id: "medium", label: "Medium", detail: "Thinks it through first" },
  { id: "high", label: "High", detail: "Takes its time on hard problems" },
];

const MODES: readonly ModeOption[] = [
  {
    id: "ask",
    label: "Ask first",
    detail: "Checks with you before it sends, books or changes anything",
  },
  {
    id: "plan",
    label: "Plan",
    detail: "Lays out a plan and waits for you to start it",
    placeholder: "Describe the job — Ada plans it before doing anything",
  },
  {
    id: "auto",
    label: "Auto",
    detail: "Works on its own within what you've already allowed",
  },
];

const COMPOSER_NOTE = "Workbench can make mistakes. Verify important inputs.";

const ALL_CAPABILITIES: ComposerCapabilities = {
  files: true,
  voice: true,
  model: true,
  mode: true,
  mentions: true,
  commands: true,
  note: true,
};

/** A reply inherits the conversation's model and mode, so the thread
 * composer leaves them, and voice, out. */
const THREAD_CAPABILITIES: ComposerCapabilities = {
  files: true,
  voice: false,
  model: false,
  mode: false,
  mentions: true,
  commands: true,
  note: false,
};

/** A comma list from the URL, blanks dropped; `null` when not given. */
function listParam(params: URLSearchParams, name: string): readonly string[] | null {
  const listed = params.get(name);
  if (listed === null) return null;
  return listed
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** `?composer=files,mentions` turns on only those; `?composer=-model,-voice`
 * turns those off and keeps the rest; `?composer=` turns everything off. */
function capabilitiesFrom(entries: readonly string[] | null): ComposerCapabilities {
  if (entries === null) return ALL_CAPABILITIES;
  const removing = entries.length > 0 && entries.every((entry) => entry.startsWith("-"));
  const named = new Set(removing ? entries.map((entry) => entry.slice(1)) : entries);
  const on = (key: keyof ComposerCapabilities) => (removing ? !named.has(key) : named.has(key));
  return {
    files: on("files"),
    voice: on("voice"),
    model: on("model"),
    mode: on("mode"),
    mentions: on("mentions"),
    commands: on("commands"),
    note: on("note"),
  };
}

function tokensFor(capabilities: ComposerCapabilities): readonly Suggestion[] {
  return [
    ...(capabilities.mentions ? MENTIONABLE : []),
    ...(capabilities.commands ? COMMANDS : []),
  ];
}

/** Every response action, in the playground's order. A real surface passes
 * only what it wants; with nothing passed there are none. */
const ALL_ACTIONS: readonly MessageActionId[] = [
  "upvote",
  "downvote",
  "copy",
  "regenerate",
  "react",
  "reply",
  "pin",
  "link",
];

/** `?actions=copy,regenerate` shows only those, in that order;
 * `?actions=-react,-pin` drops those; `?actions=` shows none. */
function actionsFrom(entries: readonly string[] | null): readonly MessageActionId[] {
  if (entries === null) return ALL_ACTIONS;
  if (entries.length === 0) return NO_ACTIONS;
  if (entries.every((entry) => entry.startsWith("-"))) {
    const dropped = new Set(entries.map((entry) => entry.slice(1)));
    return ALL_ACTIONS.filter((action) => !dropped.has(action));
  }
  return entries.flatMap((entry) => {
    const action = ALL_ACTIONS.find((candidate) => candidate === entry);
    return action === undefined ? [] : [action];
  });
}

type ComposerPrefs = { readonly model: ModelChoice; readonly modeId: string };

const DEFAULT_PREFS: ComposerPrefs = {
  model: { modelId: "claude-sonnet-5-5", reasoningId: "medium" },
  modeId: "ask",
};

let idSeed = 0;
function nextId(prefix: string): string {
  idSeed += 1;
  return `${prefix}-${idSeed}`;
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** A wall-clock time on a past day, e.g. a scheduled run's 8:00. */
function daysAgoAt(days: number, hour: number, minute = 0): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function shortDate(days: number): string {
  return new Date(daysAgoAt(days, 12)).toLocaleDateString([], { month: "short", day: "numeric" });
}

function text(value: string): TextPart {
  return { type: "text", text: value };
}

type MessageExtra = Partial<
  Pick<ChatMessage, "status" | "threadId" | "thread" | "reactions" | "feedback" | "pinned" | "via">
> & { readonly id?: string };

function message(
  authorId: string,
  at: string,
  parts: readonly ChatPart[],
  extra: MessageExtra = {},
): ChatMessage {
  const { id, status, ...rest } = extra;
  return {
    type: "message",
    id: id ?? nextId("m"),
    authorId,
    at,
    parts,
    status: status ?? "sent",
    ...rest,
  };
}

function newAgentMessage(agentId: string, threadId?: string): ChatMessage {
  return message(agentId, new Date().toISOString(), [], {
    status: "streaming",
    ...(threadId === undefined ? {} : { threadId }),
  });
}

function system(at: string, value: string): SystemEntry {
  return { type: "system", id: nextId("s"), at, text: value };
}

const REPORT_V1 = `# Weekly repo report

Fourteen pull requests merged since Monday. Most are small; two change how workers recover, and those carry the risk this week.

## What shipped

- **Centered conversation layout** — the timeline and composer share one column.
- **Chat loader and scroll** — the thread no longer jumps on load.
- **Settings redaction** — secrets are masked in end-to-end fixtures.

## Risk

The redeploy cap decides whether a dead worker restarts on its own. It resets on a page reload, so a worker that keeps dying can loop once per visit.

## Recommendation

Merge the layout and settings work today. Hold the redeploy change until it has a test for \`diedQuickly\`.`;

const REPORT_V2 = `${REPORT_V1}

## Follow-ups

1. Add a test for \`diedQuickly\` covering a run with no \`endedAt\`.
2. Persist the redeploy cap across reloads.
3. Track deploys per day in next week's report.`;

/** A stand-in screenshot of a pricing page, as an SVG data URL: what a
 * person would paste from their browser. */
function mockScreenshot(title: string, accent: string, rows: readonly string[]): string {
  const lines = rows
    .map(
      (row, index) =>
        `<rect x="32" y="${112 + index * 44}" width="576" height="32" rx="6" fill="#f4f2ef"/>` +
        `<text x="48" y="${133 + index * 44}" font-family="sans-serif" font-size="15" fill="#2b2627">${row}</text>`,
    )
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${144 + rows.length * 44}">` +
    `<rect width="100%" height="100%" fill="#fff"/>` +
    `<rect width="100%" height="72" fill="${accent}"/>` +
    `<text x="32" y="46" font-family="sans-serif" font-size="24" font-weight="700" fill="#fff">${title}</text>` +
    lines +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const RAMP_PRICING = mockScreenshot("Ramp — Pricing", "#e98428", [
  "Ramp · Free — corporate cards, expenses",
  "Ramp Plus · $15 per user / month (was $12)",
  "Travel booking · included in Plus from Nov 1",
  "Procurement · add-on, priced by quote",
]);

const EXPENSIFY_PRICING = mockScreenshot("Expensify — Plans", "#607c9a", [
  "Collect · $5 per member / month",
  "Control · $9 per member / month, annual",
  "Free card with any plan",
]);

const LOST_DEALS = `Account,Stage lost,Lost to,Reason
Northwind Freight,Proposal,Expensify,Price per seat
Kestrel Health,Trial,Expensify,Mobile receipts
Alder & Co,Proposal,Ramp,Bundled travel
Bluepeak Labs,Demo,Expensify,Price per seat`;

const RISK_SHEET = `PR,Area,Risk,Owner,Status
#1112,Chat layout,Low,Alex,Merged
#1115,Loader and scroll,Low,Alex,Merged
#1114,Settings redaction,Low,Sam,Merged
#1098,Redeploy cap,High,Sam,In review
#1102,Ollama e2e,Medium,Linus,Merged
#1107,Tool grants,Medium,Sam,Merged`;

const TEST_FILE = `import { expect, test } from "bun:test";

import { diedQuickly } from "./deployment-liveness";

test("a run with no endedAt falls back to updatedAt", () => {
  const run = {
    createdAt: "2026-10-14T10:00:00Z",
    updatedAt: "2026-10-14T10:01:00Z",
    endedAt: null,
  };
  expect(diedQuickly(run)).toBe(true);
});

test("a run that lived past the window is not a quick death", () => {
  const run = {
    createdAt: "2026-10-14T10:00:00Z",
    updatedAt: "2026-10-14T10:09:00Z",
    endedAt: "2026-10-14T10:09:00Z",
  };
  expect(diedQuickly(run)).toBe(false);
});`;

const BRIEF_PREVIEW = `# Morning brief — preview

## Needs you
1. **Stripe — renewal terms.** Reply by Thursday. They propose 2.6% + 30¢, up from 2.4%.
2. **Navan — partnership intro** from Priya Nair. She wants 30 minutes this week.
3. **Board deck.** Sam needs the partnerships slide by Friday.

## Competitors
- **Ramp** launched travel booking inside the card app.
- **Brex** changed its pricing page; no public numbers yet.
- **Mercury** — nothing new.

## Skipped
14 newsletters, 6 receipts, 3 calendar updates.`;

const BRIEF_DAY_2 = BRIEF_PREVIEW.replace("Morning brief — preview", "Morning brief");

const BRIEF_DAY_1 = `# Morning brief

## Needs you
1. **Navan.** Priya can do Thursday 2 PM or Friday 10 AM.
2. **Stripe replied:** they'll match 2.5% if you sign by month end.

## Competitors
- **Mercury** announced a rewards card for startups (1.5% back, no annual fee).
- **Ramp** and **Brex** — nothing new.

## Skipped
11 newsletters, 4 receipts.`;

const BRIEF_DAY_0 = `# Morning brief

## Needs you
1. **Board deck.** Sam's partnerships slide is due Friday; last year's is attached in his email.

## Competitors
Quiet day. No launches or pricing changes from Ramp, Brex, Navan or Mercury.

## Skipped
9 newsletters, 2 receipts, 1 calendar update.`;

const STRIPE_REPLY_V1 = `Hi Dana,

Thanks for sending the renewal terms. We've grown volume about 40% year over year and expect that to continue, so the move to 2.6% is hard for us to justify.

Could we land at 2.5% + 30¢? In return we're happy to commit to a 12-month term and keep Stripe as our sole processor for card payments.

Happy to get on a call this week if that's easier.

Best,
Alex`;

const STRIPE_REPLY_V2 = `Hi Dana,

Thanks for the renewal terms. With volume up about 40% this year, 2.6% is hard for us to justify.

Could we land at 2.5% + 30¢?

Best,
Alex`;

const TRIAGE_SHEET = `From,Subject,Ask,Suggested
Dana Ortiz (Stripe),Renewal contract,Sign at 2.5% + 30¢,Sign this week
Jordan Lee (Plaid),Co-marketing webinar,Join a November webinar,Ask for dates
Sam Chen,Board deck,Partnerships slide by Fri,Draft the slide
Priya Nair (Navan),Thursday call,Agenda for Thursday,Send agenda Wed
Carta,409A reminder,None — FYI,Archive
Mercury,Product update,None — newsletter,Archive
AngelList,Weekly digest,None — newsletter,Archive`;

const PRICING_V1 = `Company,Plan,Price,Notes
Ramp,Free,$0,Cards and expenses
Ramp,Plus,$12/user/mo,Procurement and travel
Brex,Essentials,$0,Cards and expenses
Brex,Premium,$12/user/mo,Custom policies
Navan,Business,Quote only,Travel and expense
Mercury,Standard,$0,Banking and cards`;

const PRICING_V2 = `Company,Plan,Price,Notes
Ramp,Free,$0,Cards and expenses
Ramp,Plus,$15/user/mo,Up from $12
Brex,Essentials,$0,Cards and expenses
Brex,Premium,$12/user/mo,No change
Navan,Starter,$0,New free tier
Navan,Business,Quote only,Travel and expense
Mercury,Standard,$0,No change`;

function baseArtifacts(): ReadonlyMap<string, Artifact> {
  const artifacts: Artifact[] = [
    {
      id: "art-report",
      title: "Weekly repo report",
      kind: "doc",
      versions: [
        {
          version: 1,
          at: minutesAgo(40),
          authorId: ADA.id,
          content: REPORT_V1,
          note: "First draft",
        },
        {
          version: 2,
          at: minutesAgo(9),
          authorId: ADA.id,
          content: REPORT_V2,
          note: "Added follow-ups from Sam's thread",
        },
      ],
    },
    {
      id: "art-risk",
      title: "PR risk matrix",
      kind: "sheet",
      versions: [
        {
          version: 1,
          at: minutesAgo(38),
          authorId: ADA.id,
          content: RISK_SHEET,
          note: "Scored every merged PR",
        },
      ],
    },
    {
      id: "art-test",
      title: "deployment-liveness.test.ts",
      kind: "code",
      language: "TypeScript",
      versions: [
        {
          version: 1,
          at: minutesAgo(6),
          authorId: LINUS.id,
          content: TEST_FILE,
          note: "Covers the endedAt fallback",
        },
      ],
    },
    {
      id: "art-brief-preview",
      title: "Morning brief — preview",
      kind: "doc",
      versions: [
        {
          version: 1,
          at: daysAgoAt(4, 10, 17),
          authorId: ADA.id,
          content: BRIEF_PREVIEW,
          note: "What tomorrow's brief will look like",
        },
      ],
    },
    ...[
      { days: 2, content: BRIEF_DAY_2 },
      { days: 1, content: BRIEF_DAY_1 },
      { days: 0, content: BRIEF_DAY_0 },
    ].map(({ days, content }): Artifact => ({
      id: `art-brief-${days}`,
      title: `Morning brief · ${shortDate(days)}`,
      kind: "doc",
      versions: [
        {
          version: 1,
          at: daysAgoAt(days, 8),
          authorId: ADA.id,
          content,
          note: "Scheduled run",
        },
      ],
    })),
    {
      id: "art-stripe-reply",
      title: "Reply to Stripe — renewal",
      kind: "doc",
      versions: [
        {
          version: 1,
          at: daysAgoAt(2, 8, 42),
          authorId: ADA.id,
          content: STRIPE_REPLY_V1,
          note: "First draft",
        },
        {
          version: 2,
          at: daysAgoAt(2, 9, 6),
          authorId: ADA.id,
          content: STRIPE_REPLY_V2,
          note: "Shorter, no term commitment",
        },
      ],
    },
    {
      id: "art-triage",
      title: "Inbox triage",
      kind: "sheet",
      versions: [
        {
          version: 1,
          at: minutesAgo(49),
          authorId: ADA.id,
          content: TRIAGE_SHEET,
          note: "9 threads read, 7 listed",
        },
      ],
    },
    {
      id: "art-pricing",
      title: "Competitor pricing",
      kind: "sheet",
      versions: [
        {
          version: 1,
          at: daysAgoAt(4, 10, 25),
          authorId: SCOUT.id,
          content: PRICING_V1,
          note: "Baseline",
        },
        {
          version: 2,
          at: minutesAgo(150),
          authorId: SCOUT.id,
          content: PRICING_V2,
          note: "Ramp Plus up $3; Navan added a free tier",
        },
      ],
    },
  ];
  return new Map(artifacts.map((artifact) => [artifact.id, artifact]));
}

const WEEKLY_ANSWER = `Here's the week. Fourteen PRs merged; two touch worker recovery and carry the risk.

I wrote it up as a report and scored every PR in a sheet — the redeploy cap is the only **high** risk item. To check it yourself:

\`\`\`bash
git log --since="1 week" --merges --oneline -- packages/worker
\`\`\`

The cap lives in \`restartBudget()\`; it allows 3 restarts in 10 minutes.`;

function conversationScenario(): readonly TimelineEntry[] {
  const reportMessageId = "m-report";
  return [
    system(minutesAgo(60 * 26), "Ada joined · Alex Rivera created this workbench"),
    message(ME.id, minutesAgo(60 * 26 - 1), [
      text("Hey Ada — can you keep an eye on the workbench repo for me?"),
    ]),
    message(
      ADA.id,
      minutesAgo(60 * 26 - 2),
      [text("Will do. I'll watch merged PRs and flag anything that touches deploys or auth.")],
      { reactions: [{ emoji: "👍", count: 1, mine: true }] },
    ),
    message(ME.id, minutesAgo(42), [
      text("What changed this week? Attaching the roadmap so you know what matters."),
      { type: "file", name: "q4-roadmap.pdf", mediaType: "application/pdf", size: "412 KB" },
    ]),
    message(
      ADA.id,
      minutesAgo(41),
      [
        {
          type: "reasoning",
          text: "Alex wants a weekly summary weighted by the roadmap. List merged PRs since Monday, read the diffs that touch deploy and chat, and call out risk.",
          durationMs: 6200,
        },
        {
          type: "tool",
          id: "t1",
          name: "github__list_pull_requests",
          label: "Listed merged pull requests",
          state: "done",
          detail: "14 merged since Monday",
        },
        { type: "tool", id: "t2", name: "github__get_diff", label: "Read 4 diffs", state: "done" },
        {
          type: "tool",
          id: "t3",
          name: "exa__search",
          label: "Searched release notes",
          state: "error",
          detail: "Rate limited — skipped",
        },
        text(WEEKLY_ANSWER),
        { type: "artifact", artifactId: "art-report", version: 1, change: "created" },
        { type: "artifact", artifactId: "art-risk", version: 1, change: "created" },
        {
          type: "sources",
          sources: [
            {
              title: "#1112 Centered conversation layout",
              url: "https://github.com/corbitsdev/workbench/pull/1112",
            },
            {
              title: "#1115 Chat loader and scroll",
              url: "https://github.com/corbitsdev/workbench/pull/1115",
            },
          ],
        },
      ],
      {
        id: reportMessageId,
        feedback: "up",
        reactions: [
          { emoji: "🎉", count: 2, mine: true },
          { emoji: "👀", count: 1, mine: false },
        ],
        thread: { count: 2, lastAt: minutesAgo(10) },
      },
    ),
    message(
      SAM.id,
      minutesAgo(12),
      [text("Can the report list follow-ups too? I'd like to track them next week.")],
      { threadId: reportMessageId },
    ),
    message(
      ADA.id,
      minutesAgo(10),
      [
        text("Added a Follow-ups section — three items, the `diedQuickly` test first."),
        { type: "artifact", artifactId: "art-report", version: 2, change: "updated" },
      ],
      { threadId: reportMessageId },
    ),
    message(
      ADA.id,
      minutesAgo(9),
      [{ type: "artifact", artifactId: "art-report", version: 2, change: "updated" }],
      { pinned: true },
    ),
    message(ME.id, minutesAgo(7), [text("Great. Open an issue for the missing test, please.")]),
    message(ADA.id, minutesAgo(6), [
      {
        type: "tool",
        id: "t4",
        name: "github__create_issue",
        label: "Prepared an issue",
        state: "done",
      },
      {
        type: "approval",
        id: "ap1",
        tool: "github__create_issue",
        summary: "Create an issue in corbitsdev/workbench titled “Add a test for diedQuickly”.",
        scope: "Writes to a public repository as you.",
        decision: null,
      },
    ]),
  ];
}

const PLAN_STEPS = [
  "Pull merged PRs since Monday",
  "Read the roadmap and match PRs to goals",
  "Score each PR for risk",
  "Write the weekly report",
];

function planScenario(): readonly TimelineEntry[] {
  return [
    message(ME.id, minutesAgo(50), [
      text("Every Friday, send me a report on what shipped and what's risky."),
    ]),
    message(ADA.id, minutesAgo(49), [
      text("Here's how I'd do it. Start it and I'll run the first one now."),
      {
        type: "plan",
        id: "plan-weekly",
        title: "Weekly repo report",
        state: "proposed",
        steps: PLAN_STEPS.map((label, index) => ({
          id: `ps-${index}`,
          label,
          status: "pending",
        })),
      },
    ]),
    message(ME.id, minutesAgo(30), [text("@Linus can you add the missing test meanwhile?")]),
    message(LINUS.id, minutesAgo(6), [
      {
        type: "plan",
        id: "plan-test",
        title: "Cover diedQuickly",
        state: "done",
        steps: [
          { id: "pt-1", label: "Read deployment-liveness.ts", status: "done" },
          { id: "pt-2", label: "Write the endedAt fallback case", status: "done" },
          { id: "pt-3", label: "Run the suite", status: "done" },
        ],
      },
      {
        type: "tool",
        id: "t9",
        name: "shell__run",
        label: "Ran bun test",
        state: "done",
        detail: "2 pass · 0 fail",
      },
      text("Both cases pass. The fallback to `updatedAt` behaves as Sam described."),
      { type: "artifact", artifactId: "art-test", version: 1, change: "created" },
    ]),
  ];
}

function failureScenario(): readonly TimelineEntry[] {
  return [
    message(ME.id, minutesAgo(8), [text("Summarize the last three incidents.")]),
    message(ADA.id, minutesAgo(8), [
      text(
        "I couldn't reach the model provider: **Your credit balance is too low.** Add credit or connect another provider in Settings, then ask again.",
      ),
    ]),
    message(ME.id, minutesAgo(1), [text("Trying again after topping up.")], { status: "failed" }),
  ];
}

function teamScenario(): readonly TimelineEntry[] {
  return [
    system(minutesAgo(90), "Linus joined · Sam Chen added Linus to this workbench"),
    message(SAM.id, minutesAgo(30), [
      text("@Linus can you review the redeploy PR before Alex merges it?"),
    ]),
    message(LINUS.id, minutesAgo(29), [
      { type: "tool", id: "t5", name: "github__get_diff", label: "Read the diff", state: "done" },
      text(
        "Two things: the cap resets on a page reload, and `diedQuickly` trusts `updatedAt` when `endedAt` is missing. Otherwise LGTM.",
      ),
    ]),
    message(ME.id, minutesAgo(20), [
      text("@Ada can you check whether `endedAt` is ever missing on stopped runs?"),
    ]),
    message(ADA.id, minutesAgo(19), [
      {
        type: "tool",
        id: "t6",
        name: "postgres__query",
        label: "Queried stopped runs",
        state: "done",
        detail: "0 of 1,204 stopped runs lack endedAt",
      },
      text(
        "It's never missing on stopped runs, so the fallback only matters for errored ones. Safe to merge.",
      ),
    ]),
  ];
}

const LONG_REPLIES = [
  "Done — I've updated the summary and pinned it to the workbench.",
  "Here's the breakdown:\n\n- **3** deploys\n- **1** rollback\n- **0** open incidents",
  "I checked `main` and the build is green. The flaky test is `insights-stats.test.ts`.",
  "That PR touches auth, so I'd hold it until Sam reviews it.",
];

function longScenario(count: number): readonly TimelineEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const at = minutesAgo((count - index) * 7);
    if (index % 2 === 0) {
      return message(ME.id, at, [
        text(`Question ${index / 2 + 1}: what's the status of task ${index}?`),
      ]);
    }
    const parts: ChatPart[] = [];
    if (index % 6 === 1) {
      parts.push({
        type: "tool",
        id: `lt-${index}`,
        name: "github__search",
        label: "Searched the repo",
        state: "done",
      });
    }
    parts.push(text(LONG_REPLIES[index % LONG_REPLIES.length] ?? ""));
    return message(index % 10 === 3 ? LINUS.id : ADA.id, at, parts);
  });
}

const GMAIL_SEND = "gmail__send_message";
const GMAIL_SCOPE = "Sends email from your Gmail account as you.";

/** One workbench, four days in. A partnerships lead sets it up, the worker
 * connects mail, installs a morning brief and creates a pricing agent; then
 * three days of briefs, a reply drafted in a thread, the agent's weekly
 * check, and today's inbox pass. */
function partnershipsScenario(): readonly TimelineEntry[] {
  const tuesday = "m-brief-2";
  return [
    // Day one: setup.
    system(daysAgoAt(4, 10), "Alex Rivera created this workbench"),
    message(ADA.id, daysAgoAt(4, 10), [
      text(
        "Hi Alex — I'm your new co-worker for this workbench. Here's what I can do right away:\n\n- **Search the web** and summarize what I find\n- **Read and write files** here, and remember what matters\n- **Read and send mail** once you connect an account\n- **Run things on a schedule**, like a morning brief\n\nWhat should I call myself? If you'd rather not pick, I'll go with **Ada**.",
      ),
    ]),
    message(ME.id, daysAgoAt(4, 10, 3), [
      text(
        "Ada works. I run partnerships at a fintech startup. I'm buried in email, and I want to keep up with what Ramp, Brex and Navan ship.",
      ),
    ]),
    system(daysAgoAt(4, 10, 3), "You named your worker Ada"),
    message(ADA.id, daysAgoAt(4, 10, 4), [
      text("Nice to meet you, Alex. Two things would cover most of that:"),
      {
        type: "connect",
        id: "cn-gmail",
        service: "Gmail",
        reason:
          "Connect Gmail so I can read your inbox and draft replies. I'll always ask before sending anything.",
        state: "connected",
      },
      {
        type: "offer",
        id: "of-brief",
        kind: "workflow",
        name: "Morning brief",
        summary:
          "Every weekday at 8:00, I read your inbox and the competitors' blogs, then post a one-page brief here.",
        needs: ["Read your mail", "Search the web"],
        state: "installed",
      },
    ]),
    message(ME.id, daysAgoAt(4, 10, 12), [text("Done, both. Am I missing any competitors?")]),
    message(ADA.id, daysAgoAt(4, 10, 13), [
      {
        type: "tool",
        id: "pt-1",
        name: "exa__search",
        label: "Searched for spend management competitors",
        state: "done",
        detail: "18 results",
      },
      text(
        "**Mercury** and **Airwallex** come up most often next to the three you named. Want either in the brief?",
      ),
    ]),
    message(ME.id, daysAgoAt(4, 10, 15), [text("Add Mercury, skip Airwallex.")]),
    message(ADA.id, daysAgoAt(4, 10, 17), [
      {
        type: "tool",
        id: "pt-2",
        name: "workflow__update",
        label: "Updated Morning brief",
        state: "done",
        detail: "Now watching Ramp, Brex, Navan and Mercury",
      },
      text("Added. Here's what tomorrow's brief will look like:"),
      { type: "artifact", artifactId: "art-brief-preview", version: 1, change: "created" },
      text(
        "One more idea: pricing pages change quietly. A dedicated agent could check them every Friday. It needs a web browser, which I don't carry, so it would be its own agent with only that access.",
      ),
      {
        type: "offer",
        id: "of-scout",
        kind: "agent",
        name: "Pricing scout",
        summary:
          "Checks Ramp, Brex, Navan and Mercury pricing pages every Friday and posts only what changed.",
        needs: ["Browse websites (Browserbase)", "Search the web (Exa)"],
        state: "installed",
      },
    ]),
    system(daysAgoAt(4, 10, 19), "Pricing scout joined · Ada created it for this workbench"),
    message(SCOUT.id, daysAgoAt(4, 10, 20), [
      {
        type: "approval",
        id: "ap-browse",
        tool: "browserbase__navigate",
        summary: "Open the pricing pages of ramp.com, brex.com, navan.com and mercury.com.",
        scope: "Read-only browsing. Nothing is submitted and no account is signed in.",
        decision: "always",
      },
    ]),
    message(SCOUT.id, daysAgoAt(4, 10, 25), [
      {
        type: "tool",
        id: "pt-3",
        name: "browserbase__navigate",
        label: "Opened 4 pricing pages",
        state: "done",
      },
      {
        type: "tool",
        id: "pt-4",
        name: "browserbase__extract",
        label: "Read the plan tables",
        state: "done",
      },
      {
        type: "tool",
        id: "pt-5",
        name: "exa__search",
        label: "Checked for pricing announcements",
        state: "error",
        detail: "Navan returned nothing — skipped",
      },
      text("Baseline saved. I'll check every Friday at 9:00 and only post when something changes."),
      { type: "artifact", artifactId: "art-pricing", version: 1, change: "created" },
    ]),

    // The first brief, and a reply drafted in its thread.
    message(
      ADA.id,
      daysAgoAt(2, 8),
      [
        text(
          "**3 need you** — Stripe's renewal terms, a Navan intro, and Sam's board slide. Ramp launched travel booking; Brex quietly changed its pricing page.",
        ),
        { type: "artifact", artifactId: "art-brief-2", version: 1, change: "created" },
        {
          type: "sources",
          sources: [
            { title: "Ramp — Introducing Ramp Travel", url: "https://ramp.com/blog" },
            { title: "Brex — Pricing", url: "https://www.brex.com/pricing" },
          ],
        },
      ],
      {
        id: tuesday,
        via: "Morning brief",
        thread: { count: 4, lastAt: daysAgoAt(2, 9, 6) },
      },
    ),
    message(
      ME.id,
      daysAgoAt(2, 8, 40),
      [text("Draft a reply to Stripe and push back on the rate.")],
      {
        threadId: tuesday,
      },
    ),
    message(
      ADA.id,
      daysAgoAt(2, 8, 42),
      [
        {
          type: "tool",
          id: "pt-6",
          name: "gmail__read_thread",
          label: "Read the Stripe thread",
          state: "done",
        },
        text("Drafted. I countered at 2.5% and offered a 12-month term in return."),
        { type: "artifact", artifactId: "art-stripe-reply", version: 1, change: "created" },
      ],
      { threadId: tuesday },
    ),
    message(ME.id, daysAgoAt(2, 9, 5), [text("Shorter, and don't offer the term.")], {
      threadId: tuesday,
    }),
    message(
      ADA.id,
      daysAgoAt(2, 9, 6),
      [
        text("Down to three sentences, no commitment."),
        { type: "artifact", artifactId: "art-stripe-reply", version: 2, change: "updated" },
        {
          type: "approval",
          id: "ap-stripe",
          tool: GMAIL_SEND,
          summary: "Send “Re: Renewal terms” to partnerships@stripe.example.",
          scope: GMAIL_SCOPE,
          decision: "once",
        },
      ],
      { threadId: tuesday },
    ),

    // Yesterday.
    message(
      ADA.id,
      daysAgoAt(1, 8),
      [
        text(
          "**2 need you** — Priya at Navan can do Thursday or Friday, and Stripe will match 2.5% if you sign by month end. Mercury announced a rewards card for startups.",
        ),
        { type: "artifact", artifactId: "art-brief-1", version: 1, change: "created" },
      ],
      { via: "Morning brief", reactions: [{ emoji: "🎉", count: 1, mine: true }] },
    ),
    message(ME.id, daysAgoAt(1, 8, 30), [
      text("Great news on Stripe. Take Priya's Thursday slot."),
    ]),
    message(ADA.id, daysAgoAt(1, 8, 31), [
      {
        type: "tool",
        id: "pt-7",
        name: "gcal__find_free_time",
        label: "Checked your calendar",
        state: "done",
        detail: "Free Thursday 2–3 PM",
      },
      {
        type: "approval",
        id: "ap-priya",
        tool: GMAIL_SEND,
        summary: "Send “Re: Intro — Navan” to priya@navan.example, accepting Thursday at 2 PM.",
        scope: GMAIL_SCOPE,
        decision: "always",
      },
      text("Sent, and it's on your calendar."),
    ]),

    // Today.
    message(
      ADA.id,
      minutesAgo(200),
      [
        text(
          "**1 needs you** — Sam's partnerships slide is due Friday. Quiet otherwise: no competitor launches or pricing changes.",
        ),
        { type: "artifact", artifactId: "art-brief-0", version: 1, change: "created" },
      ],
      { via: "Morning brief" },
    ),
    message(ME.id, minutesAgo(185), [text("Can the brief be shorter? Just the top three things.")]),
    message(ADA.id, minutesAgo(184), [
      {
        type: "tool",
        id: "pt-8",
        name: "workflow__update",
        label: "Updated Morning brief",
        state: "done",
        detail: "Capped at three items",
      },
      text(
        "Done. From tomorrow the brief stops at three items; everything else stays in the attached report.",
      ),
    ]),
    message(
      SCOUT.id,
      minutesAgo(150),
      [
        text(
          "**2 changes this week.** Ramp raised Plus from $12 to $15 per user. Navan added a free Starter tier. Brex and Mercury are unchanged.\n\n| Company | Plan | Price | Change |\n| --- | --- | --- | --- |\n| Ramp | Plus | $15 / user / mo | Up from $12 |\n| Navan | Starter | Free | New tier |\n| Brex | Premium | $12 / user / mo | — |\n| Mercury | Standard | Free | — |",
        ),
        { type: "artifact", artifactId: "art-pricing", version: 2, change: "updated" },
        {
          type: "sources",
          sources: [
            { title: "Ramp — Pricing", url: "https://ramp.com/pricing" },
            { title: "Navan — Plans", url: "https://navan.com/pricing" },
          ],
        },
      ],
      { via: "Pricing check" },
    ),
    message(SAM.id, minutesAgo(140), [
      {
        type: "file",
        name: "expensify-plans.png",
        mediaType: "image/svg+xml",
        size: "48 KB",
        previewUrl: EXPENSIFY_PRICING,
      },
      {
        type: "file",
        name: "lost-deals-q3.csv",
        mediaType: "text/csv",
        size: "4 rows",
        excerpt: LOST_DEALS,
      },
      text("@Pricing scout can you add Expensify? We keep losing deals to them."),
    ]),
    message(SCOUT.id, minutesAgo(139), [text("Added Expensify. It'll be in Friday's check.")]),
    message(ME.id, minutesAgo(120), [
      {
        type: "file",
        name: "ramp-pricing.png",
        mediaType: "image/svg+xml",
        size: "62 KB",
        previewUrl: RAMP_PRICING,
      },
      text("@Ada lead tomorrow's brief with Ramp's price change."),
    ]),
    message(ADA.id, minutesAgo(119), [text("Will do. It'll be the first item tomorrow at 8:00.")]),
    message(ME.id, minutesAgo(50), [
      text("Go through my unread and tell me what actually needs me."),
    ]),
    message(ADA.id, minutesAgo(49), [
      {
        type: "reasoning",
        text: "23 unread. Sort by sender and ask: does this need Alex's decision, can it wait, or is it noise? Anything with a deadline goes first.",
        durationMs: 3800,
      },
      {
        type: "tool",
        id: "pt-9",
        name: "gmail__list_messages",
        label: "Listed unread mail",
        state: "done",
        detail: "23 unread",
      },
      {
        type: "tool",
        id: "pt-10",
        name: "gmail__read_thread",
        label: "Read 9 threads",
        state: "done",
      },
      {
        type: "tool",
        id: "pt-11",
        name: "files__write",
        label: "Saved a triage sheet",
        state: "done",
      },
      text(
        "**3 need you, 6 can wait, 14 are noise.**\n\n1. **Dana (Stripe)** sent the renewal contract at 2.5% for your signature.\n2. **Jordan Lee (Plaid)** wants you on a co-marketing webinar in November.\n3. **Sam** asked whether the partnerships slide is ready for Friday.\n\nI drafted a reply to Jordan. The contract needs your signature, so it's at the top of the sheet.",
      ),
      { type: "artifact", artifactId: "art-triage", version: 1, change: "created" },
    ]),
    message(ADA.id, minutesAgo(48), [
      {
        type: "approval",
        id: "ap-jordan",
        tool: GMAIL_SEND,
        summary:
          "Send “Re: Co-marketing webinar” to jordan@plaid.example, asking for November dates.",
        scope: GMAIL_SCOPE,
        decision: null,
      },
    ]),
    message(ME.id, minutesAgo(30), [text("And the 14 newsletters?")]),
    message(ADA.id, minutesAgo(29), [
      text(
        "Most come from five senders you haven't opened in months. I can archive those automatically and keep a weekly list, in case you want anything back.",
      ),
      {
        type: "offer",
        id: "of-sweep",
        kind: "workflow",
        name: "Newsletter sweep",
        summary:
          "Archives mail from senders you haven't opened in 30 days and posts a weekly list of what it moved.",
        needs: ["Read your mail", "Archive mail"],
        state: "offered",
      },
    ]),
  ];
}

const STRESS_WORDS =
  "the vendor renewal terms pricing contract clause notice period auto renew discount seat tier usage overage invoice quarter annual partner pipeline risk owner deadline review approval budget forecast churn expansion signal benchmark competitor".split(
    " ",
  );

/** Deterministic filler prose: `words` words, sentence-cased. */
function stressProse(words: number, seed: number): string {
  const out: string[] = [];
  let sentence = 0;
  for (let index = 0; index < words; index += 1) {
    const word = STRESS_WORDS[(index * 7 + seed * 13 + sentence) % STRESS_WORDS.length] ?? "the";
    const startsSentence = index === 0 || out.at(-1)?.endsWith(".") === true;
    out.push(startsSentence ? word.charAt(0).toUpperCase() + word.slice(1) : word);
    if (index % 14 === 13) {
      out[out.length - 1] = `${out.at(-1)}.`;
      sentence += 1;
    }
  }
  return `${out.join(" ")}.`;
}

const STRESS_TOOLS: readonly (readonly [string, string])[] = [
  ["gmail__search", "Searched mail for"],
  ["drive__read", "Read"],
  ["exa__search", "Searched the web for"],
  ["browser__open", "Opened"],
  ["sheets__update", "Updated the sheet with"],
  ["notion__read", "Read the page on"],
];

function stressTool(index: number, state: ToolState, subject: string, batch?: string): ToolPart {
  const [name, verb] = STRESS_TOOLS[index % STRESS_TOOLS.length] ?? ["tool", "Ran"];
  return {
    type: "tool",
    id: `stress-tool-${subject}-${index}`,
    name,
    label: `${verb} ${subject} ${index + 1}`,
    state,
    ...(batch === undefined ? {} : { batch }),
  };
}

/** A long answer with every block kind Streamdown draws. */
function stressAnswer(sections: number): string {
  return Array.from({ length: sections }, (_, index) => {
    const table =
      index % 3 === 0
        ? `\n\n| Vendor | Renews | Notice | Annual |\n| --- | --- | --- | --- |\n${Array.from(
            { length: 6 },
            (_, row) =>
              `| Vendor ${index * 6 + row + 1} | Q${(row % 4) + 1} | ${30 + row * 15} days | $${(row + 2) * 4_200} |`,
          ).join("\n")}`
        : "";
    const code =
      index % 5 === 2
        ? `\n\n\`\`\`ts\nexport const renewal${index} = { vendor: "Vendor ${index}", noticeDays: ${30 + index} };\n\`\`\``
        : "";
    return `## ${index + 1}. Contract group ${index + 1}\n\n${stressProse(120, index)}\n\n- ${stressProse(12, index + 1)}\n- ${stressProse(10, index + 2)}\n- ${stressProse(14, index + 3)}${table}${code}`;
  }).join("\n\n");
}

function stressScenario(): readonly TimelineEntry[] {
  const loop: ChatPart[] = [];
  for (let round = 0; round < 20; round += 1) {
    loop.push({ type: "reasoning", text: stressProse(60, round), durationMs: 2_000 + round * 100 });
    for (let call = 0; call < 3; call += 1)
      loop.push(stressTool(round * 3 + call, "done", "round"));
  }
  return [
    message(ME.id, daysAgoAt(1, 9, 0), [
      text("Audit every vendor contract and flag what renews this quarter."),
    ]),
    message(ADA.id, daysAgoAt(1, 9, 4), [
      ...Array.from({ length: 200 }, (_, index) =>
        stressTool(index, index === 141 ? "error" : "done", "contract"),
      ),
      text("Read 200 contracts. **14 renew this quarter**; one file couldn't be opened."),
    ]),
    message(ME.id, daysAgoAt(1, 10, 0), [
      text("Check pricing pages for all twelve competitors at once."),
    ]),
    message(ADA.id, daysAgoAt(1, 10, 1), [
      ...Array.from({ length: 12 }, (_, index) =>
        stressTool(index + 2, "done", "competitor", "competitors"),
      ),
      text("All twelve checked in parallel; two changed prices."),
    ]),
    message(ME.id, daysAgoAt(1, 11, 0), [text("Work through the renewal queue one by one.")]),
    message(ADA.id, daysAgoAt(1, 11, 9), [
      ...loop,
      text("Twenty renewals worked through; six need your sign-off."),
    ]),
    message(ME.id, daysAgoAt(0, 9, 0), [text("Think hard about which renewals to renegotiate.")]),
    message(ADA.id, daysAgoAt(0, 9, 3), [
      { type: "reasoning", text: stressProse(8_000, 3), durationMs: 184_000 },
      text("Renegotiate four: the ones with auto-renew and a price rise above 8%."),
    ]),
    message(ME.id, daysAgoAt(0, 9, 30), [text("Write the full renewal report.")]),
    message(ADA.id, daysAgoAt(0, 9, 34), [text(`# Renewal report\n\n${stressAnswer(80)}`)]),
  ];
}

/** A live heavy turn: long thinking, waves of parallel calls between
 * sequential ones, then a very long answer, streamed fast. */
function scriptStressTurn(): readonly TurnFrame[] {
  const frames: TurnFrame[] = [];
  const thought = stressProse(2_500, 9);
  for (let length = 240; length < thought.length; length += 240) {
    frames.push({ delayMs: 16, parts: [{ type: "reasoning", text: thought.slice(0, length) }] });
  }
  const parts: ChatPart[] = [{ type: "reasoning", text: thought, durationMs: 41_000 }];
  for (let wave = 0; wave < 6; wave += 1) {
    const ids = Array.from({ length: 8 }, (_, call) => wave * 8 + call);
    // A parallel wave: all start together, finish one by one.
    frames.push({
      delayMs: 120,
      parts: [...parts, ...ids.map((id) => stressTool(id, "running", "source", `wave-${wave}`))],
    });
    for (let done = 1; done <= ids.length; done += 1) {
      frames.push({
        delayMs: 60,
        parts: [
          ...parts,
          ...ids.map((id, position) =>
            stressTool(id, position < done ? "done" : "running", "source", `wave-${wave}`),
          ),
        ],
      });
    }
    parts.push(...ids.map((id) => stressTool(id, "done", "source", `wave-${wave}`)));
  }
  const answer = `# Findings\n\n${stressAnswer(40)}`;
  for (let length = 400; length < answer.length; length += 400) {
    frames.push({ delayMs: 16, parts: [...parts, text(answer.slice(0, length))] });
  }
  frames.push({ delayMs: 16, parts: [...parts, text(answer)], done: true });
  return frames;
}

const ART_PALETTES: readonly (readonly [string, string, string])[] = [
  ["#f7ead5", "#e98428", "#2b2627"],
  ["#2b2627", "#e98428", "#f2b277"],
  ["#c5d2de", "#607c9a", "#2b2627"],
  ["#c1d1be", "#7b9974", "#2b2627"],
  ["#f2b277", "#9e4a45", "#f7ead5"],
];

/** A stand-in for a generated image: an abstract composition as an SVG
 * data URL, deterministic per seed. */
function mockArt(seed: number, width: number, height: number, alt: string): GeneratedImage {
  const [ground, accent, ink] = ART_PALETTES[seed % ART_PALETTES.length] ?? [
    "#fff",
    "#000",
    "#000",
  ];
  const unit = Math.min(width, height);
  const cx = width * (0.3 + ((seed * 37) % 40) / 100);
  const cy = height * (0.35 + ((seed * 23) % 30) / 100);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${ground}"/><stop offset="1" stop-color="${accent}" stop-opacity="0.35"/></linearGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${unit * 0.22}" fill="${accent}"/>` +
    `<rect x="${width * 0.1}" y="${height * 0.72}" width="${width * 0.8}" height="${unit * 0.02}" fill="${ink}" opacity="0.8"/>` +
    `<rect x="${width * 0.1}" y="${height * 0.78}" width="${width * 0.45}" height="${unit * 0.02}" fill="${ink}" opacity="0.45"/>` +
    `<path d="M${width * 0.55} ${height * 0.62} L${width * 0.75} ${height * 0.3} L${width * 0.92} ${height * 0.62} Z" fill="${ink}" opacity="0.85"/>` +
    `</svg>`;
  return {
    id: `art-${seed}-${width}x${height}`,
    url: `data:image/svg+xml,${encodeURIComponent(svg)}`,
    mediaType: "image/svg+xml",
    width,
    height,
    alt,
  };
}

const IMAGE_MODEL = "Image model";

function imagesScenario(): readonly TimelineEntry[] {
  const coverPrompt = "Cover for the Q3 partnerships deck: warm, minimal, one mountain motif";
  return [
    message(ME.id, daysAgoAt(0, 10, 0), [
      text("Make a cover image for the Q3 partnerships deck. Warm, minimal."),
    ]),
    message(ADA.id, daysAgoAt(0, 10, 1), [
      {
        type: "reasoning",
        text: "Four directions, landscape for slides, brand palette.",
        durationMs: 3_000,
      },
      {
        type: "tool",
        id: "img-t1",
        name: "image__generate",
        label: "Generated 4 images",
        state: "done",
      },
      {
        type: "image",
        id: "img-1",
        prompt: coverPrompt,
        state: "done",
        model: IMAGE_MODEL,
        images: [1, 2, 3, 4].map((seed) => mockArt(seed, 1536, 1024, `Deck cover option ${seed}`)),
      },
      text("Four directions. The second matches the deck's orange best."),
    ]),
    message(ME.id, daysAgoAt(0, 10, 5), [
      text("Make a square version of the second one for LinkedIn."),
    ]),
    message(ADA.id, daysAgoAt(0, 10, 6), [
      {
        type: "image",
        id: "img-2",
        prompt: "Square crop of option 2 for a LinkedIn post",
        state: "done",
        model: IMAGE_MODEL,
        images: [mockArt(2, 1024, 1024, "Square LinkedIn version of option 2")],
      },
      text("Here it is at 1024 × 1024."),
    ]),
    message(ME.id, daysAgoAt(0, 10, 9), [text("And a tall one for stories.")]),
    message(ADA.id, daysAgoAt(0, 10, 10), [
      {
        type: "image",
        id: "img-3",
        prompt: "Tall 9:16 version of option 2 for stories",
        state: "error",
        model: IMAGE_MODEL,
        images: [],
        expected: { count: 1, width: 1024, height: 1820 },
      },
      text("The image model timed out on that one."),
    ]),
  ];
}

/** A live image turn: a short thought, the generate call running while
 * placeholders hold the space, then the images and a line about them. */
function scriptImageTurn(prompt: string): readonly TurnFrame[] {
  const id = nextId("img");
  const thought: ReasoningPart = {
    type: "reasoning",
    text: "Two takes, square, brand palette.",
    durationMs: 2_000,
  };
  const running: ToolPart = {
    type: "tool",
    id: `${id}-t`,
    name: "image__generate",
    label: "Generating 2 images",
    state: "running",
  };
  const expected = { count: 2, width: 1024, height: 1024 };
  const generating: ImagePart = {
    type: "image",
    id,
    prompt,
    state: "generating",
    images: [],
    expected,
    model: IMAGE_MODEL,
  };
  const seed = Number(id.replace(/\D/g, "")) || 7;
  const done: ImagePart = {
    ...generating,
    state: "done",
    images: [
      mockArt(seed, 1024, 1024, `${prompt} (take 1)`),
      mockArt(seed + 1, 1024, 1024, `${prompt} (take 2)`),
    ],
  };
  const finished: ChatPart[] = [
    thought,
    { ...running, state: "done", label: "Generated 2 images" },
    done,
  ];
  return [
    { delayMs: 400, parts: [{ type: "reasoning", text: thought.text }] },
    { delayMs: 700, parts: [thought, running, generating] },
    { delayMs: 2400, parts: finished },
    ...streamText(finished, "Two takes. Click either to see it full size.", 6, 22),
  ];
}

/** How much history a long conversation keeps in the page, and how much
 * more each scroll to the top brings in. */
const HISTORY_WINDOW = 120;
const HISTORY_PAGE = 60;

/** The prototype shows one workbench. The edge states below stay reachable
 * for testing through `?scenario=` — there is no switcher on screen. */
const SCENARIO_IDS = [
  "partnerships",
  "empty",
  "streaming",
  "failure",
  "team",
  "work",
  "conversation",
  "long",
  "stress",
  "images",
] as const;

type ScenarioId = (typeof SCENARIO_IDS)[number];

const SCENARIO_BENCH: Record<ScenarioId, string> = {
  partnerships: "Partnerships",
  empty: "New workbench",
  streaming: "Weekly repo watch",
  failure: "Weekly repo watch",
  team: "Weekly repo watch",
  work: "Weekly repo watch",
  conversation: "Weekly repo watch",
  long: "Weekly repo watch",
  stress: "Vendor renewals",
  images: "Brand studio",
};

/** The reply `?scenario=streaming` opens on, already under way. */
const STREAMING_REPLY_ID = "m-streaming";

/** The playground's switches, read once from the URL. */
type PlaygroundConfig = {
  readonly scenario: ScenarioId;
  /** How many messages `?scenario=long` builds. */
  readonly count: number;
  readonly capabilities: ComposerCapabilities;
  readonly actions: readonly MessageActionId[];
  readonly showMap: boolean;
  readonly showThreadActions: boolean;
  readonly avatars: boolean;
  readonly names: boolean;
};

function playgroundFromURL(): PlaygroundConfig {
  const params = new URLSearchParams(location.search);
  const requested = params.get("scenario");
  const count = Number(params.get("count") ?? 500);
  // `?solo` is one person with one agent: no avatars, no name lines.
  const solo = params.has("solo");
  return {
    scenario: SCENARIO_IDS.find((id) => id === requested) ?? "partnerships",
    count: Number.isFinite(count) ? Math.min(Math.max(count, 10), 20_000) : 500,
    capabilities: capabilitiesFrom(listParam(params, "composer")),
    actions: actionsFrom(listParam(params, "actions")),
    showMap: params.get("map") !== "off",
    showThreadActions: params.get("threadactions") !== "off",
    avatars: !solo && params.get("avatars") !== "off",
    names: !solo && params.get("names") !== "off",
  };
}

function scenarioEntries(id: ScenarioId, count: number): readonly TimelineEntry[] {
  switch (id) {
    case "partnerships":
      return partnershipsScenario();
    case "conversation":
      return conversationScenario();
    case "work":
      return planScenario();
    case "streaming":
      return [
        ...conversationScenario().slice(0, 4),
        { ...newAgentMessage(ADA.id), id: STREAMING_REPLY_ID },
      ];
    case "empty":
      return [];
    case "team":
      return teamScenario();
    case "failure":
      return failureScenario();
    case "long":
      return longScenario(count);
    case "stress":
      return stressScenario();
    case "images":
      return imagesScenario();
  }
}

type TurnFrame = {
  readonly delayMs: number;
  /** A full snapshot of the message's parts at this point. */
  readonly parts: readonly ChatPart[];
  /** An artifact this frame creates or revises. */
  readonly artifact?: Artifact;
  readonly done?: boolean;
};

const STREAMED_ANSWER = `Done. Fourteen PRs merged; the redeploy cap is the one to hold.

The report is above — I'll send the next one Friday at 9:00.`;

function streamText(
  prefix: readonly ChatPart[],
  value: string,
  chunk: number,
  delayMs: number,
): TurnFrame[] {
  const frames: TurnFrame[] = [];
  for (let length = chunk; length < value.length; length += chunk) {
    frames.push({ delayMs, parts: [...prefix, text(value.slice(0, length))] });
  }
  frames.push({ delayMs, parts: [...prefix, text(value)], done: true });
  return frames;
}

/** What a scripted turn is about: its thinking, plan, steps and result.
 * Each workbench gets a turn that fits its own story. */
type WorkStory = {
  readonly thought: string;
  readonly title: string;
  /** Four plan steps; the last is written up as the artifact. */
  readonly steps: readonly string[];
  /** Three tool calls: name, label while running, label once done. */
  readonly tools: readonly (readonly [string, string, string])[];
  readonly artifactTitle: string;
  readonly content: string;
  readonly answer: string;
};

const REPO_STORY: WorkStory = {
  thought:
    "Pull merged PRs, cross-check the roadmap, score risk, then write it up as a report Alex can forward.",
  title: "Weekly repo report",
  steps: PLAN_STEPS,
  tools: [
    ["github__list_pull_requests", "Listing merged pull requests", "Listed merged pull requests"],
    ["files__read", "Reading q4-roadmap.pdf", "Read q4-roadmap.pdf"],
    ["github__get_diff", "Reading risky diffs", "Read 4 diffs"],
  ],
  artifactTitle: "Weekly repo report",
  content: REPORT_V1,
  answer: STREAMED_ANSWER,
};

const PARTNERSHIPS_STORY: WorkStory = {
  thought:
    "Alex wants the board slide. Read the screenshot and notes, find this quarter's signed partners in mail, check the numbers against the pipeline sheet, then draft one slide.",
  title: "Partnerships board slide",
  steps: [
    "Read the screenshot and notes",
    "Find this quarter's signed partners",
    "Check the numbers against the pipeline",
    "Draft the slide",
  ],
  tools: [
    ["files__read", "Reading your notes and screenshot", "Read your notes and screenshot"],
    ["gmail__search", "Finding signed agreements", "Found 4 signed agreements"],
    ["sheets__read", "Reading the pipeline sheet", "Matched 4 deals"],
  ],
  artifactTitle: "Partnerships — board slide",
  content: `# Partnerships — Q3

## Signed this quarter
- **Stripe** — renewal at 2.5% + 30¢, down from the 2.6% they proposed
- **Navan** — co-sell agreement; first call Thursday
- **Plaid** — co-marketing webinar in November
- **Mercury** — referral partnership, live in October

## Pipeline
$1.2M in active partner-sourced pipeline, up 34% from Q2.

## Next quarter
1. Close the Navan co-sell terms.
2. Launch the Plaid webinar.
3. Add Expensify to competitive tracking.`,
  answer: `Done. One slide: four partners signed, $1.2M in partner-sourced pipeline (up 34%), and three priorities for next quarter.

Want me to send it to Sam for the deck?`,
};

/** A turn that thinks, works through a live plan, writes a report, then answers. */
function scriptWorkTurn(
  prefix: readonly ChatPart[],
  planId: string,
  story: WorkStory,
): readonly TurnFrame[] {
  const frames: TurnFrame[] = [];
  const lead: ChatPart[] = [...prefix];
  if (prefix.length === 0) {
    const thought = story.thought;
    const words = thought.split(" ");
    for (let i = 1; i <= words.length; i += 3) {
      frames.push({
        delayMs: 50,
        parts: [{ type: "reasoning", text: words.slice(0, i).join(" ") }],
      });
    }
    lead.push({ type: "reasoning", text: thought, durationMs: 2100 });
  }
  const plan = (active: number, state: PlanPart["state"] = "running"): PlanPart => ({
    type: "plan",
    id: planId,
    title: story.title,
    state,
    steps: story.steps.map((label, index) => ({
      id: `${planId}-${index}`,
      label,
      status: index < active ? "done" : index === active ? "active" : "pending",
    })),
  });
  const tool = (index: number, name: string, label: string, state: ToolState): ToolPart => ({
    type: "tool",
    id: `${planId}-tool-${index}`,
    name,
    label,
    state,
  });
  const settled: ToolPart[] = [];
  story.tools.forEach(([name, running, finished], index) => {
    frames.push({
      delayMs: index === 0 ? 300 : 200,
      parts: [...lead, plan(index), ...settled, tool(index, name, running, "running")],
    });
    settled.push(tool(index, name, finished, "done"));
    frames.push({ delayMs: 900, parts: [...lead, plan(index + 1), ...settled] });
  });
  const reportId = `art-${planId}`;
  const draft: Artifact = { id: reportId, title: story.artifactTitle, kind: "doc", versions: [] };
  const pending: ArtifactPart = {
    type: "artifact",
    artifactId: reportId,
    version: 1,
    change: "created",
    pending: true,
  };
  frames.push({ delayMs: 300, parts: [...lead, plan(3), ...settled, pending], artifact: draft });
  const written: Artifact = {
    ...draft,
    versions: [
      {
        version: 1,
        at: new Date().toISOString(),
        authorId: ADA.id,
        content: story.content,
        note: "First draft",
      },
    ],
  };
  const ready: ArtifactPart = { ...pending, pending: false };
  const finished = [...lead, plan(4, "done"), ...settled, ready];
  frames.push({ delayMs: 1600, parts: finished, artifact: written });
  frames.push(...streamText(finished, story.answer, 5, 22));
  return frames;
}

function scriptThreadReply(): readonly TurnFrame[] {
  return [
    { delayMs: 500, parts: [] },
    ...streamText(
      [],
      "Good call — I'll fold that into the report and post the revision here.",
      4,
      26,
    ),
  ];
}

/** A response streaming in again, in its original order: text reveals a
 * few characters a frame, and anything after a text part (a card, a file)
 * appears once that text is complete. */
function replayFrames(parts: readonly ChatPart[]): readonly TurnFrame[] {
  const total = parts.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
  const upTo = (budget: number): readonly ChatPart[] => {
    const shown: ChatPart[] = [];
    let left = budget;
    for (const part of parts) {
      if (part.type !== "text") {
        shown.push(part);
        continue;
      }
      if (left <= 0) break;
      if (left < part.text.length) {
        shown.push(text(part.text.slice(0, left)));
        break;
      }
      shown.push(part);
      left -= part.text.length;
    }
    return shown;
  };
  const frames: TurnFrame[] = [{ delayMs: 600, parts: upTo(0) }];
  for (let budget = 6; budget < total; budget += 6) {
    frames.push({ delayMs: 24, parts: upTo(budget) });
  }
  frames.push({ delayMs: 24, parts, done: true });
  return frames;
}

/** The id of the last message `authorId` sent, if any. */
function lastSentBy(entries: readonly TimelineEntry[], authorId: string): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.authorId === authorId) return entry.id;
  }
  return undefined;
}

function replaceMessage(
  entries: readonly TimelineEntry[],
  id: string,
  update: (message: ChatMessage) => ChatMessage,
): readonly TimelineEntry[] {
  return entries.map((entry) =>
    entry.type === "message" && entry.id === id ? update(entry) : entry,
  );
}

/** Rewrites one part, found by its kind and id, wherever it sits. */
function replacePart<K extends ChatPart["type"]>(
  entries: readonly TimelineEntry[],
  type: K,
  id: string,
  update: (part: Extract<ChatPart, { readonly type: K }>) => ChatPart,
): readonly TimelineEntry[] {
  const matches = (part: ChatPart): part is Extract<ChatPart, { readonly type: K }> =>
    part.type === type && "id" in part && part.id === id;
  return entries.map((entry) =>
    entry.type === "message" && entry.parts.some(matches)
      ? { ...entry, parts: entry.parts.map((part) => (matches(part) ? update(part) : part)) }
      : entry,
  );
}

/** The `@` or `/` word being typed at the end of the draft, if any. */
function activeToken(value: string): { readonly prefix: "@" | "/"; readonly query: string } | null {
  const match = /(?:^|\s)([@/])([\w-]*)$/.exec(value);
  const prefix = match?.[1];
  const query = match?.[2];
  if ((prefix !== "@" && prefix !== "/") || query === undefined) return null;
  return { prefix, query };
}

function toggleReaction(reactions: readonly Reaction[], emoji: string): readonly Reaction[] {
  const existing = reactions.find((reaction) => reaction.emoji === emoji);
  if (existing === undefined) return [...reactions, { emoji, count: 1, mine: true }];
  const next = existing.mine
    ? { ...existing, count: existing.count - 1, mine: false }
    : { ...existing, count: existing.count + 1, mine: true };
  return reactions
    .map((reaction) => (reaction.emoji === emoji ? next : reaction))
    .filter((reaction) => reaction.count > 0);
}

type DraftState = {
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly menuOpen: boolean;
  readonly suggestionIndex: number;
  readonly notice: string | null;
};

const EMPTY_DRAFT: DraftState = {
  text: "",
  attachments: [],
  menuOpen: false,
  suggestionIndex: 0,
  notice: null,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentFromFile(file: File): Attachment {
  const image = file.type.startsWith("image/");
  return {
    id: nextId("f"),
    name: file.name === "" ? (image ? "Pasted image" : "File") : file.name,
    mediaType: file.type === "" ? "application/octet-stream" : file.type,
    size: formatBytes(file.size),
    // Every file gets a local URL: pictures and video preview from it, and
    // anything else can still open in the browser.
    previewUrl: URL.createObjectURL(file),
    fingerprint: fingerprintOf(file),
  };
}

function attachmentFromText(value: string): Attachment {
  const lines = value.split("\n").length;
  return {
    id: nextId("f"),
    name: "Pasted text",
    mediaType: "text/plain",
    size: `${lines} ${lines === 1 ? "line" : "lines"}`,
    excerpt: value.slice(0, 280),
  };
}

function filePart(attachment: Attachment): FilePart {
  return {
    type: "file",
    name: attachment.name,
    mediaType: attachment.mediaType,
    size: attachment.size,
    ...(attachment.previewUrl === undefined ? {} : { previewUrl: attachment.previewUrl }),
    ...(attachment.excerpt === undefined ? {} : { excerpt: attachment.excerpt }),
  };
}

/** Where a turn runs: the main conversation or the open thread. Each has its
 * own composer, its own in-flight turn and its own Stop. */
type Scope = "main" | "thread";

const IDLE: Readonly<Record<Scope, ComposerStatus>> = { main: "ready", thread: "ready" };

/** True while a turn is open but nothing of it is on screen yet: the gap
 * the live chat's working label covers. Once the turn streams, its own
 * parts (thinking, plan, steps, the text caret) show the progress, and a
 * second "Thinking…" under them would only repeat it. */
function awaitingFirstContent(status: ComposerStatus, entries: readonly TimelineEntry[]): boolean {
  if (status === "ready") return false;
  return !entries.some(
    (entry) => entry.type === "message" && entry.status === "streaming" && entry.parts.length > 0,
  );
}

function suggestionsFor(value: string, capabilities: ComposerCapabilities): readonly Suggestion[] {
  const typing = activeToken(value);
  if (typing === null) return [];
  const pool =
    typing.prefix === "@"
      ? capabilities.mentions
        ? MENTIONABLE
        : []
      : capabilities.commands
        ? COMMANDS
        : [];
  const query = `${typing.prefix}${typing.query}`.toLowerCase();
  return pool.filter((option) => option.token.toLowerCase().startsWith(query));
}

export function ChatPrototypeRoute() {
  const [config] = useState(playgroundFromURL);
  const { scenario, actions, showMap, showThreadActions } = config;
  // Simulated turns follow the workbench's own story.
  const story = scenario === "partnerships" ? PARTNERSHIPS_STORY : REPO_STORY;
  const [entries, setEntries] = useState<readonly TimelineEntry[]>(() =>
    scenarioEntries(config.scenario, config.count),
  );
  const [artifacts, setArtifacts] = useState<ReadonlyMap<string, Artifact>>(baseArtifacts);
  const [panel, setPanel] = useState<PanelState | null>(null);
  // Each panel kind remembers its own width across opens.
  const [panelWidths, setPanelWidths] = useState<{
    readonly thread: number | null;
    readonly artifact: number | null;
  }>({ thread: null, artifact: null });
  const [main, setMain] = useState<DraftState>(EMPTY_DRAFT);
  const [reply, setReply] = useState<DraftState>(EMPTY_DRAFT);
  const [context, setContext] = useState<ComposerContext | null>(null);
  const [capabilities] = useState<Readonly<Record<Scope, ComposerCapabilities>>>(() => ({
    main: config.capabilities,
    thread: THREAD_CAPABILITIES,
  }));
  const tokens = useMemo(
    () => ({ main: tokensFor(capabilities.main), thread: tokensFor(capabilities.thread) }),
    [capabilities],
  );
  const [mutedThreads, setMutedThreads] = useState<ReadonlySet<string>>(() => new Set());
  const [viewer, setViewer] = useState<{
    readonly items: readonly ViewedMedia[];
    readonly index: number;
  } | null>(null);
  /** A file was clicked, in a message or the composer. Pictures, video and
   * text open in the viewer with the rest of the set a step away; anything
   * else (a PDF) opens in the browser. */
  const openFiles = useCallback((files: readonly FilePart[], index: number) => {
    const clicked = files[index];
    if (clicked === undefined) return;
    const viewable = files.flatMap((file) => {
      const media = viewableOf(file);
      return media === null ? [] : [{ file, media }];
    });
    const at = viewable.findIndex((entry) => entry.file === clicked);
    if (at !== -1) {
      setViewer({ items: viewable.map((entry) => entry.media), index: at });
      return;
    }
    if (clicked.previewUrl !== undefined) {
      window.open(clicked.previewUrl, "_blank", "noopener,noreferrer");
    }
  }, []);
  // Model and mode outlive a sent draft, so they live beside it.
  const [prefs, setPrefs] = useState<Readonly<Record<Scope, ComposerPrefs>>>({
    main: DEFAULT_PREFS,
    thread: DEFAULT_PREFS,
  });
  const [turns, setTurns] = useState<Readonly<Record<Scope, ComposerStatus>>>(IDLE);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const entriesRef = useRef(entries);
  const turnsRef = useRef(turns);
  const turnTimers = useRef<Record<Scope, ReturnType<typeof setTimeout>[]>>({
    main: [],
    thread: [],
  });
  const streamingIds = useRef<Record<Scope, string | null>>({ main: null, thread: null });
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryTimers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useLayoutEffect(() => {
    entriesRef.current = entries;
    turnsRef.current = turns;
  }, [entries, turns]);

  const setTurn = useCallback((scope: Scope, value: ComposerStatus) => {
    turnsRef.current = { ...turnsRef.current, [scope]: value };
    setTurns((current) => ({ ...current, [scope]: value }));
  }, []);

  const clearTurn = useCallback((scope: Scope) => {
    turnTimers.current[scope].forEach(clearTimeout);
    turnTimers.current[scope] = [];
  }, []);

  useEffect(
    () => () => {
      clearTurn("main");
      clearTurn("thread");
      clearTimeout(copyTimer.current);
      retryTimers.current.forEach(clearTimeout);
    },
    [clearTurn],
  );

  /** Plays frames into a message: a new one, or an existing one resumed. */
  const play = useCallback(
    (
      scope: Scope,
      frames: readonly TurnFrame[],
      target: { readonly create: ChatMessage } | { readonly resume: string },
    ) => {
      const id = "create" in target ? target.create.id : target.resume;
      streamingIds.current[scope] = id;
      setTurn(scope, "streaming");
      if ("create" in target) {
        setEntries((current) => [...current, target.create]);
      } else {
        setEntries((current) =>
          replaceMessage(current, id, (existing) => ({ ...existing, status: "streaming" })),
        );
      }
      let elapsed = 0;
      for (const frame of frames) {
        elapsed += frame.delayMs;
        turnTimers.current[scope].push(
          setTimeout(() => {
            const { artifact } = frame;
            if (artifact !== undefined) {
              setArtifacts((current) => new Map(current).set(artifact.id, artifact));
            }
            setEntries((current) =>
              replaceMessage(current, id, (existing) => ({
                ...existing,
                parts: frame.parts,
                status: frame.done === true ? "sent" : "streaming",
              })),
            );
            if (frame.done === true) {
              streamingIds.current[scope] = null;
              setTurn(scope, "ready");
            }
          }, elapsed),
        );
      }
    },
    [setTurn],
  );

  // `?scenario=streaming` opens on a turn already running. Every frame is a
  // full snapshot, so starting it over after a cleanup is safe.
  useEffect(() => {
    if (scenario !== "streaming") return;
    play("main", scriptWorkTurn([], nextId("plan"), story), { resume: STREAMING_REPLY_ID });
    return () => clearTurn("main");
  }, [scenario, story, play, clearTurn]);

  /** Bumps a parent's thread summary, the way a server would on a new reply. */
  const noteReply = (threadId: string, at: string) => {
    setEntries((current) =>
      replaceMessage(current, threadId, (parent) => ({
        ...parent,
        thread: { count: (parent.thread?.count ?? 0) + 1, lastAt: at },
      })),
    );
  };

  const send = (draft: DraftState, threadId?: string) => {
    const scope: Scope = threadId === undefined ? "main" : "thread";
    const trimmed = draft.text.trim();
    if ((trimmed === "" && draft.attachments.length === 0) || turnsRef.current[scope] !== "ready") {
      return;
    }
    const at = new Date().toISOString();
    // Files lead, as in Claude: what was shared, then what was said about it.
    const parts: ChatPart[] = [
      ...draft.attachments.map(filePart),
      ...(trimmed === "" ? [] : [text(trimmed)]),
    ];
    const sent = message(ME.id, at, parts, {
      status: "sending",
      ...(threadId === undefined ? {} : { threadId }),
    });
    setEntries((current) => [...current, sent]);
    if (threadId === undefined) {
      setMain(EMPTY_DRAFT);
      setContext(null);
    } else {
      setReply(EMPTY_DRAFT);
      noteReply(threadId, at);
    }
    setTurn(scope, "submitting");
    const addressed = AGENTS.find((agent) => trimmed.includes(`@${agent.name}`)) ?? ADA;
    turnTimers.current[scope].push(
      setTimeout(() => {
        setEntries((current) =>
          replaceMessage(current, sent.id, (existing) => ({ ...existing, status: "sent" })),
        );
        if (threadId === undefined) {
          play(
            "main",
            scenario === "stress"
              ? scriptStressTurn()
              : scenario === "images"
                ? scriptImageTurn(trimmed)
                : scriptWorkTurn([], nextId("plan"), story),
            {
              create: newAgentMessage(addressed.id),
            },
          );
        } else {
          noteReply(threadId, new Date().toISOString());
          play("thread", scriptThreadReply(), {
            create: newAgentMessage(addressed.id, threadId),
          });
        }
      }, 450),
    );
  };

  const stop = useCallback(
    (scope: Scope) => {
      clearTurn(scope);
      const id = streamingIds.current[scope];
      streamingIds.current[scope] = null;
      setTurn(scope, "ready");
      if (id === null) return;
      setEntries((current) =>
        replaceMessage(current, id, (existing) => ({ ...existing, status: "sent" })),
      );
    },
    [clearTurn, setTurn],
  );

  const copyText = useCallback((id: string, value: string) => {
    navigator.clipboard.writeText(value).catch((cause: unknown) => {
      reportError(cause, { operation: "chat_prototype_copy" });
    });
    setCopiedId(id);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedId(null), 1500);
  }, []);

  // One stable object, so memoized rows never re-render for a new callback.
  const handlers = useMemo<MessageHandlers>(
    () => ({
      onOpenThread: (target) => setPanel({ kind: "thread", messageId: target.id }),
      onCopy: (target) => copyText(target.id, messageText(target)),
      onRetry: (target) => {
        setEntries((current) => current.filter((entry) => entry.id !== target.id));
        setMain({ ...EMPTY_DRAFT, text: messageText(target) });
      },
      onRegenerate: (target) => {
        const scope: Scope = target.threadId === undefined ? "main" : "thread";
        if (turnsRef.current[scope] !== "ready") return;
        // The mock replays the same answer in its own order, and the old
        // rating no longer applies to the new one.
        setEntries((current) =>
          replaceMessage(current, target.id, ({ feedback: _rated, ...existing }) => ({
            ...existing,
            parts: [],
          })),
        );
        play(scope, replayFrames(target.parts), { resume: target.id });
      },
      onDecide: (approvalId, decision) =>
        setEntries((current) =>
          replacePart(current, "approval", approvalId, (part) => ({ ...part, decision })),
        ),
      onReact: (messageId, emoji) =>
        setEntries((current) =>
          replaceMessage(current, messageId, (existing) => ({
            ...existing,
            reactions: toggleReaction(existing.reactions ?? [], emoji),
          })),
        ),
      onFeedback: (messageId, value) =>
        setEntries((current) =>
          replaceMessage(current, messageId, (existing) => {
            const { feedback, ...rest } = existing;
            return feedback === value ? rest : { ...rest, feedback: value };
          }),
        ),
      onTogglePin: (messageId) =>
        setEntries((current) =>
          replaceMessage(current, messageId, (existing) => {
            const { pinned, ...rest } = existing;
            return pinned === true ? rest : { ...rest, pinned: true };
          }),
        ),
      onCopyLink: (messageId) =>
        copyText(messageId, `${location.origin}${location.pathname}#${messageId}`),
      onOpenArtifact: (artifactId, version) => setPanel({ kind: "artifact", artifactId, version }),
      onStartPlan: (messageId) => {
        // One run at a time in the main conversation; the button is disabled
        // too, this guards a click that lands as a turn starts.
        if (turnsRef.current.main !== "ready") return;
        const target = entriesRef.current.find(
          (entry): entry is ChatMessage => entry.type === "message" && entry.id === messageId,
        );
        const plan = target?.parts.find((part): part is PlanPart => part.type === "plan");
        if (target === undefined || plan === undefined) return;
        // Work happens where the person is looking: the proposal folds to a
        // line, and the live run arrives as a new turn at the bottom.
        setEntries((current) =>
          replacePart(current, "plan", plan.id, (part) => ({ ...part, state: "started" })),
        );
        play("main", scriptWorkTurn([], nextId("plan"), story), {
          create: newAgentMessage(target.authorId),
        });
      },
      onResolveOffer: (offerId, state) =>
        setEntries((current) =>
          replacePart(current, "offer", offerId, (part) => ({ ...part, state })),
        ),
      onResolveConnect: (connectId, state) =>
        setEntries((current) =>
          replacePart(current, "connect", connectId, (part) => ({ ...part, state })),
        ),
      onOpenFile: openFiles,
      onRetryImage: (partId) => {
        // The mock makes it again: placeholders first, then the image.
        const update = (state: ImagePart["state"]) =>
          setEntries((current) =>
            replacePart(current, "image", partId, (part) => {
              const shape = part.expected ?? { count: 1, width: 1024, height: 1024 };
              return state === "done"
                ? {
                    ...part,
                    state,
                    images: Array.from({ length: shape.count }, (_, index) =>
                      mockArt(index + 3, shape.width, shape.height, part.prompt),
                    ),
                  }
                : { ...part, state, images: [] };
            }),
          );
        update("generating");
        const timer = setTimeout(() => {
          retryTimers.current.delete(timer);
          update("done");
        }, 2_000);
        retryTimers.current.add(timer);
      },
    }),
    [copyText, play, openFiles],
  );

  const topLevel = useMemo(
    () => entries.filter((entry) => entry.type === "system" || entry.threadId === undefined),
    [entries],
  );
  const empty = topLevel.length === 0;

  // A long conversation keeps a window of its history in the page: the
  // latest HISTORY_WINDOW messages, older ones added a page at a time as the
  // reader scrolls up. `null` follows the newest; a message id pins where
  // the window starts. While the reader is away from the bottom the start
  // stays put, so nothing they're reading is pruned out from under them;
  // back at the bottom, the window shrinks to its usual size again.
  const [windowStart, setWindowStart] = useState<string | null>(null);
  const startIndex = useMemo(() => {
    const tail = Math.max(0, topLevel.length - HISTORY_WINDOW);
    if (windowStart === null) return tail;
    const at = topLevel.findIndex((entry) => entry.id === windowStart);
    return at === -1 ? tail : at;
  }, [topLevel, windowStart]);
  const shown = useMemo(() => topLevel.slice(startIndex), [topLevel, startIndex]);
  const loadEarlier = useCallback(() => {
    setWindowStart(topLevel[Math.max(0, startIndex - HISTORY_PAGE)]?.id ?? null);
  }, [topLevel, startIndex]);
  const firstShown = shown[0]?.id;
  const firstShownRef = useRef(firstShown);
  useLayoutEffect(() => {
    firstShownRef.current = firstShown;
  }, [firstShown]);
  const followHistory = useCallback((atBottom: boolean) => {
    if (atBottom) setWindowStart(null);
    else setWindowStart((current) => current ?? firstShownRef.current ?? null);
  }, []);

  const turnMap = useMemo(() => conversationMap(shown, PARTICIPANTS), [shown]);
  const lastSentId = lastSentBy(topLevel, ME.id);
  const activeArtifactId = panel?.kind === "artifact" ? panel.artifactId : null;
  const openThreadId = panel?.kind === "thread" ? panel.messageId : null;

  // The drafts as of the last change, so files arriving in quick succession
  // (two drops, a drop and a paste) are each weighed against what the one
  // before them added, not against a render that hasn't happened yet.
  const draftsRef = useRef<Readonly<Record<Scope, DraftState>>>({ main, thread: reply });
  useLayoutEffect(() => {
    draftsRef.current = { main, thread: reply };
  }, [main, reply]);
  // Every file's preview is a blob URL; leaving the page lets them all go.
  useEffect(
    () => () => {
      const drafted = [
        ...draftsRef.current.main.attachments,
        ...draftsRef.current.thread.attachments,
      ];
      const sent = entriesRef.current.flatMap((entry) =>
        entry.type === "message" ? entry.parts.filter((part) => part.type === "file") : [],
      );
      for (const { previewUrl } of [...drafted, ...sent]) {
        if (previewUrl?.startsWith("blob:") === true) URL.revokeObjectURL(previewUrl);
      }
    },
    [],
  );

  /** Files offered to a draft: `intakeFiles` decides which join and words
   * the notice. Text and code files are then read for their preview. */
  const addFiles = (scope: Scope, incoming: IncomingFiles) => {
    const setDraft = scope === "main" ? setMain : setReply;
    const held = draftsRef.current[scope];
    const { accepted, notice } = intakeFiles(incoming, held.attachments);
    const added = accepted.map((file) => ({ file, attachment: attachmentFromFile(file) }));
    draftsRef.current = {
      ...draftsRef.current,
      [scope]: {
        ...held,
        attachments: [...held.attachments, ...added.map((entry) => entry.attachment)],
      },
    };
    setDraft((current) => ({
      ...current,
      attachments: [...current.attachments, ...added.map((entry) => entry.attachment)],
      notice,
    }));
    for (const { file, attachment } of added) {
      const kind = mediaKindOf(attachment.mediaType, attachment.name);
      if (!readsAsText(kind) || file.size > MAX_TEXT_READ_BYTES) continue;
      file
        .text()
        .then((content) => {
          // Removed before it finished reading: the map finds nothing.
          setDraft((current) => ({
            ...current,
            attachments: current.attachments.map((item) =>
              item.id === attachment.id
                ? { ...item, excerpt: content.slice(0, MAX_TEXT_PREVIEW_CHARS) }
                : item,
            ),
          }));
        })
        .catch((cause: unknown) => {
          reportError(cause, { operation: "chat_prototype_read_file" });
        });
    }
  };

  // A file dropped outside a drop zone would make the browser open it and
  // leave the app; outside the zones, drops simply do nothing.
  useEffect(() => {
    const guard = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes("Files") === true) event.preventDefault();
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

  const composerFor = (
    scope: Scope,
    draft: DraftState,
    setDraft: (update: (current: DraftState) => DraftState) => void,
    options: { readonly placeholder: string; readonly onSubmit: () => void },
  ) => (
    <Composer
      capabilities={capabilities[scope]}
      {...(capabilities[scope].note ? { note: COMPOSER_NOTE } : {})}
      value={draft.text}
      onValueChange={(value) =>
        setDraft((current) => ({ ...current, text: value, suggestionIndex: 0, notice: null }))
      }
      onSubmit={options.onSubmit}
      onStop={() => stop(scope)}
      status={turns[scope]}
      placeholder={options.placeholder}
      menuOpen={draft.menuOpen}
      onMenuOpenChange={(open) => setDraft((current) => ({ ...current, menuOpen: open }))}
      attachments={draft.attachments}
      onAddFiles={(files) => addFiles(scope, { files, folders: [] })}
      onPasteText={(value) => {
        const attachment = attachmentFromText(value);
        setDraft((current) => ({
          ...current,
          attachments: [...current.attachments, attachment],
          notice: null,
        }));
      }}
      onOpenAttachment={(id) =>
        openFiles(
          draft.attachments.map(filePart),
          draft.attachments.findIndex((item) => item.id === id),
        )
      }
      onRemoveAttachment={(id) => {
        const removed = draft.attachments.find((item) => item.id === id);
        if (removed?.previewUrl !== undefined) URL.revokeObjectURL(removed.previewUrl);
        setDraft((current) => ({
          ...current,
          attachments: current.attachments.filter((item) => item.id !== id),
          notice: null,
        }));
      }}
      onRemoveAllAttachments={() => {
        for (const item of draft.attachments) {
          if (item.previewUrl !== undefined) URL.revokeObjectURL(item.previewUrl);
        }
        setDraft((current) => ({ ...current, attachments: [], notice: null }));
      }}
      notice={draft.notice}
      context={scope === "main" ? context : null}
      onClearContext={() => setContext(null)}
      suggestions={suggestionsFor(draft.text, capabilities[scope])}
      suggestionIndex={draft.suggestionIndex}
      onSuggestionIndexChange={(index) =>
        setDraft((current) => ({ ...current, suggestionIndex: index }))
      }
      onPickSuggestion={(option) =>
        setDraft((current) => ({
          ...current,
          text: current.text.replace(/([@/])([\w-]*)$/, `${option.token} `),
          suggestionIndex: 0,
        }))
      }
      tokens={tokens[scope]}
      onStartToken={(prefix) =>
        setDraft((current) => ({
          ...current,
          text:
            current.text === "" || /\s$/.test(current.text)
              ? `${current.text}${prefix}`
              : `${current.text} ${prefix}`,
        }))
      }
      onVoice={() => undefined}
      models={MODELS}
      reasoningLevels={REASONING_LEVELS}
      modelChoice={prefs[scope].model}
      onModelChoiceChange={(model) =>
        setPrefs((current) => ({ ...current, [scope]: { ...current[scope], model } }))
      }
      modes={MODES}
      modeId={prefs[scope].modeId}
      onModeChange={(modeId) =>
        setPrefs((current) => ({ ...current, [scope]: { ...current[scope], modeId } }))
      }
    />
  );

  /** The playground's thread header controls: a mute toggle, a width
   * toggle, and a menu with a link and a destructive delete. */
  const threadActionsFor = (parent: ChatMessage): readonly PanelAction[] => {
    const muted = mutedThreads.has(parent.id);
    const wide = panelWidths.thread !== null && panelWidths.thread >= THREAD_WIDE;
    return [
      {
        kind: "button",
        id: "mute",
        label: "Mute replies",
        icon: muted ? <BellOff aria-hidden="true" /> : <Bell aria-hidden="true" />,
        pressed: muted,
        onSelect: () =>
          setMutedThreads((current) => {
            const next = new Set(current);
            if (next.has(parent.id)) next.delete(parent.id);
            else next.add(parent.id);
            return next;
          }),
      },
      {
        kind: "button",
        id: "width",
        label: wide ? "Narrow panel" : "Widen panel",
        icon: wide ? <ArrowsIn aria-hidden="true" /> : <ArrowsOut aria-hidden="true" />,
        onSelect: () =>
          setPanelWidths((current) => ({ ...current, thread: wide ? null : THREAD_WIDE })),
      },
      {
        kind: "menu",
        id: "more",
        label: "More thread actions",
        icon: <DotsThree aria-hidden="true" />,
        items: [
          {
            id: "link",
            label: "Copy link to thread",
            icon: <LinkSimple aria-hidden="true" />,
            onSelect: () =>
              copyText(
                `thread-${parent.id}`,
                `${location.origin}${location.pathname}#thread-${parent.id}`,
              ),
          },
          {
            id: "delete",
            label: "Delete thread",
            icon: <Trash aria-hidden="true" />,
            danger: true,
            onSelect: () => {
              setPanel(null);
              setEntries((current) =>
                current
                  .filter((entry) => entry.type !== "message" || entry.threadId !== parent.id)
                  .map((entry) =>
                    entry.type === "message" && entry.id === parent.id
                      ? (({ thread: _gone, ...rest }) => rest)(entry)
                      : entry,
                  ),
              );
            },
          },
        ],
      },
    ];
  };

  let panelNode: ReactNode = null;
  if (panel?.kind === "thread") {
    const parent = entries.find(
      (entry): entry is ChatMessage => entry.type === "message" && entry.id === panel.messageId,
    );
    if (parent !== undefined) {
      const replies = entries.filter(
        (entry): entry is ChatMessage => entry.type === "message" && entry.threadId === parent.id,
      );
      panelNode = (
        <ThreadPanel
          parent={parent}
          replies={replies}
          participants={PARTICIPANTS}
          artifacts={artifacts}
          meId={ME.id}
          copiedId={copiedId}
          actions={actions}
          handlers={handlers}
          working={turns.thread !== "ready"}
          awaitingFirstContent={awaitingFirstContent(turns.thread, replies)}
          onDropFiles={
            capabilities.thread.files ? (incoming) => addFiles("thread", incoming) : undefined
          }
          sizing={{
            width: panelWidths.thread,
            onWidthChange: (width) => setPanelWidths((current) => ({ ...current, thread: width })),
          }}
          avatars={config.avatars}
          names={config.names}
          {...(showThreadActions ? { headerActions: threadActionsFor(parent) } : {})}
          onClose={() => setPanel(null)}
          composer={composerFor("thread", reply, setReply, {
            placeholder: "Reply…",
            onSubmit: () => send(reply, parent.id),
          })}
        />
      );
    }
  } else if (panel?.kind === "artifact") {
    const artifact = artifacts.get(panel.artifactId);
    const version = artifact === undefined ? undefined : artifactVersion(artifact, panel.version);
    if (artifact !== undefined && version !== undefined) {
      const copyId = `artifact-${artifact.id}`;
      panelNode = (
        <ArtifactPanel
          artifact={artifact}
          version={version}
          participants={PARTICIPANTS}
          copied={copiedId === copyId}
          onSelectVersion={(next) => setPanel({ ...panel, version: next })}
          onCopy={() => copyText(copyId, version.content)}
          onDownload={() => {
            const url = URL.createObjectURL(new Blob([version.content], { type: "text/plain" }));
            const link = document.createElement("a");
            link.href = url;
            link.download =
              artifact.kind === "code"
                ? artifact.title
                : `${artifact.title}.${artifact.kind === "sheet" ? "csv" : "md"}`;
            link.click();
            URL.revokeObjectURL(url);
          }}
          onAskForChanges={() => {
            setContext({ label: artifact.title, detail: `v${version.version}` });
            setMain((current) => ({
              ...current,
              text: current.text === "" ? "@Ada " : current.text,
            }));
          }}
          sizing={{
            width: panelWidths.artifact,
            onWidthChange: (width) =>
              setPanelWidths((current) => ({ ...current, artifact: width })),
          }}
          onClose={() => setPanel(null)}
        />
      );
    }
  }

  const working = turns.main !== "ready" || turns.thread !== "ready";

  return (
    <div className="cp-page">
      <ChatLayout
        pill={
          // The live pill, unchanged. Its drawer is out of this prototype's
          // scope, so the toggle does nothing here.
          <BenchPill
            benchName={SCENARIO_BENCH[scenario]}
            worker={{ id: ADA.id, name: ADA.name }}
            status={
              working ? { tone: "working", text: "Working…" } : { tone: "idle", text: "Live" }
            }
            rosterReady
            open={false}
            onToggle={() => undefined}
          />
        }
        conversation={
          empty ? null : (
            <Conversation
              working={turns.main !== "ready"}
              {...(lastSentId === undefined ? {} : { sentId: lastSentId })}
              {...(showMap ? { map: turnMap } : {})}
              {...(firstShown === undefined ? {} : { firstId: firstShown })}
              hasEarlier={startIndex > 0}
              onReachStart={loadEarlier}
              onAtBottomChange={followHistory}
            >
              <Timeline
                entries={shown}
                participants={PARTICIPANTS}
                artifacts={artifacts}
                meId={ME.id}
                activeArtifactId={activeArtifactId}
                openThreadId={openThreadId}
                copiedId={copiedId}
                planStartable={turns.main === "ready"}
                actions={actions}
                avatars={config.avatars}
                names={config.names}
                handlers={handlers}
              />
              {awaitingFirstContent(turns.main, topLevel) ? <Working /> : null}
            </Conversation>
          )
        }
        composer={composerFor("main", main, setMain, {
          placeholder: empty ? "Describe the job — your co-worker sets up the rest" : "Message Ada",
          onSubmit: () => send(main),
        })}
        panel={panelNode}
        onDropFiles={capabilities.main.files ? (incoming) => addFiles("main", incoming) : undefined}
      />
      {viewer === null ? null : (
        <MediaViewer
          items={viewer.items}
          index={viewer.index}
          onIndexChange={(index) =>
            setViewer((current) => (current === null ? null : { ...current, index }))
          }
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}
