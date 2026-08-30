// How a turn's tool calls sit in the conversation.
//
// One presentation serves both the live strip (`turn-activity.tsx`) and the
// persisted transcript (`timeline.tsx`), so a call that reads one way while
// it runs doesn't restyle itself the moment the turn ends. Chips, not
// collapsibles: a glyph, one sentence, a status icon, and — only when there
// is something to show — a disclosure onto plain-text detail. Calls stack
// one per call; nothing here ever folds several into a count. The sentences
// come from `tool-activity.ts`; nothing here formats a tool's own data.

import {
  BookBookmark,
  CaretRight,
  ChatCircleDots,
  Check,
  CircleNotch,
  Lightning,
  ListBullets,
  MagnifyingGlass,
  PencilSimple,
  Users,
  WarningCircle,
} from "@corbits/icons";
import type { ReactNode } from "react";
import { useState } from "react";

import { CHAT_STRINGS } from "./strings";
import {
  providerTile,
  type ToolActivityGlyph,
  type ToolActivityRow,
  type ToolActivityStatus,
} from "./tool-activity";

function StatusMarker({ status }: { readonly status: ToolActivityStatus }) {
  const icon =
    status === "failed" ? (
      <WarningCircle />
    ) : status === "running" || status === "pending" ? (
      <CircleNotch />
    ) : (
      <Check />
    );
  return (
    <span
      className="chat-tool-activity-marker"
      data-status={status}
      aria-hidden="true"
    >
      {icon}
    </span>
  );
}

function chipAccessibleName(row: ToolActivityRow): string {
  return row.status === "failed"
    ? `${CHAT_STRINGS.toolActivityFailed}. ${row.phrase}`
    : row.phrase;
}

function ActionGlyph({ glyph }: { readonly glyph: ToolActivityGlyph }) {
  let icon: ReactNode;
  switch (glyph) {
    case "search":
      icon = <MagnifyingGlass />;
      break;
    case "list":
      icon = <ListBullets />;
      break;
    case "ask":
      icon = <ChatCircleDots />;
      break;
    case "memory":
      icon = <BookBookmark />;
      break;
    case "agents":
      icon = <Users />;
      break;
    case "write":
      icon = <PencilSimple />;
      break;
    default:
      icon = <Lightning />;
      break;
  }
  return (
    <span
      className="chat-tool-activity-tile chat-tool-activity-glyph"
      aria-hidden="true"
    >
      {icon}
    </span>
  );
}

function LeadingMark({ row }: { readonly row: ToolActivityRow }) {
  const tile =
    row.provider === undefined ? undefined : providerTile(row.provider);
  if (tile !== undefined) {
    return (
      <span
        className="chat-tool-activity-tile"
        style={{ background: tile.color }}
        aria-hidden="true"
      >
        {tile.initials}
      </span>
    );
  }
  return <ActionGlyph glyph={row.glyph} />;
}

function ChipBody({
  row,
  open,
}: {
  readonly row: ToolActivityRow;
  readonly open: boolean;
}) {
  return (
    <>
      <LeadingMark row={row} />
      {row.status === "failed" ? (
        <span className="chat-tool-activity-status-word">
          {CHAT_STRINGS.toolActivityFailed}.{" "}
        </span>
      ) : null}
      <span className="chat-tool-activity-phrase">{row.phrase}</span>
      {row.meta === undefined ? null : (
        <span className="chat-tool-activity-meta" aria-hidden="true">
          {row.meta}
        </span>
      )}
      <StatusMarker status={row.status} />
      {row.detail === undefined ? null : (
        <CaretRight
          className="chat-tool-activity-caret"
          data-open={open}
          aria-hidden="true"
        />
      )}
    </>
  );
}

function ToolActivityLine({
  row,
  indented,
}: {
  readonly row: ToolActivityRow;
  readonly indented: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = row.detail !== undefined;

  if (!hasDetail) {
    return (
      <div
        className="chat-tool-activity-row"
        data-status={row.status}
        data-indented={indented}
      >
        <div className="chat-tool-activity-chip" title={row.toolName}>
          <ChipBody row={row} open={false} />
        </div>
      </div>
    );
  }

  return (
    <div
      className="chat-tool-activity-row"
      data-status={row.status}
      data-indented={indented}
    >
      <button
        type="button"
        className="chat-tool-activity-chip chat-tool-activity-trigger"
        aria-expanded={open}
        aria-label={chipAccessibleName(row)}
        title={row.toolName}
        onClick={() => setOpen((value) => !value)}
      >
        <ChipBody row={row} open={open} />
      </button>
      {open ? <p className="chat-tool-activity-detail">{row.detail}</p> : null}
    </div>
  );
}

/**
 * A run of consecutive tool calls, stacked one chip per call — never
 * folded into a summary line (§12.3: chips are not collapsibles). Each
 * chip keeps its own disclosure onto its detail; there is no group-level
 * trigger and no count of how many calls happened.
 */
export function ToolActivityGroup({
  rows,
}: {
  readonly rows: readonly ToolActivityRow[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="chat-tool-activity" data-slot="tool-activity">
      {rows.map((row) => (
        <ToolActivityLine key={row.key} row={row} indented={false} />
      ))}
    </div>
  );
}

/**
 * The mid-turn strip: the same rows, plus the two things that only exist
 * while a turn is open — the model thinking, and a retried request.
 */
export function LiveToolActivity({
  rows,
  thinking,
  retryCount,
}: {
  readonly rows: readonly ToolActivityRow[];
  readonly thinking: boolean;
  readonly retryCount: number;
}) {
  if (rows.length === 0 && !thinking && retryCount === 0) return null;
  return (
    <div
      className="chat-tool-activity chat-tool-activity-live"
      data-slot="tool-activity"
    >
      {rows.map((row) => (
        <ToolActivityLine key={row.key} row={row} indented={false} />
      ))}
      {thinking ? (
        <div className="chat-tool-activity-row chat-tool-activity-thinking">
          {CHAT_STRINGS.turnActivityThinking}
        </div>
      ) : null}
      {retryCount > 0 ? (
        <div className="chat-tool-activity-row chat-tool-activity-retry">
          {CHAT_STRINGS.turnActivityRetry(retryCount)}
        </div>
      ) : null}
    </div>
  );
}
