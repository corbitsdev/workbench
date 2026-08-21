// How a turn's tool calls sit in the conversation.
//
// One presentation serves both the live strip (`turn-activity.tsx`) and the
// persisted transcript (`timeline.tsx`), so a call that reads one way while
// it runs doesn't restyle itself the moment the turn ends. Rows, not cards:
// a status marker, one sentence, and — only when there is something to
// show — a disclosure onto plain-text detail. The sentences come from
// `tool-activity.ts`; nothing here formats a tool's own data.

import { CaretRight } from "@corbits/icons";
import { useState } from "react";

import { CHAT_STRINGS } from "./strings";
import {
  describeToolRound,
  type ToolActivityRow,
  type ToolActivityStatus,
} from "./tool-activity";

function StatusMarker({ status }: { readonly status: ToolActivityStatus }) {
  return (
    <span
      className="chat-tool-activity-marker"
      data-status={status}
      aria-hidden="true"
    />
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
        <StatusMarker status={row.status} />
        <span className="chat-tool-activity-phrase">{row.phrase}</span>
        {row.meta === undefined ? null : (
          <span className="chat-tool-activity-meta">{row.meta}</span>
        )}
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
        className="chat-tool-activity-trigger"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <StatusMarker status={row.status} />
        <span className="chat-tool-activity-phrase">{row.phrase}</span>
        {row.meta === undefined ? null : (
          <span className="chat-tool-activity-meta">{row.meta}</span>
        )}
        <CaretRight
          className="chat-tool-activity-caret"
          data-open={open}
          aria-hidden="true"
        />
      </button>
      {open ? <p className="chat-tool-activity-detail">{row.detail}</p> : null}
    </div>
  );
}

/**
 * A run of consecutive tool calls, collapsed to the one line that says
 * what the round amounted to. A single call needs no round chrome — it is
 * already one line — so it renders on its own.
 */
export function ToolActivityGroup({
  rows,
}: {
  readonly rows: readonly ToolActivityRow[];
}) {
  const round = describeToolRound(rows);
  const [open, setOpen] = useState(round.opensByDefault);

  if (rows.length === 0) return null;
  const onlyRow = rows[0];
  if (rows.length === 1 && onlyRow !== undefined) {
    return (
      <div className="chat-tool-activity">
        <ToolActivityLine row={onlyRow} indented={false} />
      </div>
    );
  }

  return (
    <div className="chat-tool-activity" data-round="true">
      <button
        type="button"
        className="chat-tool-activity-trigger"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <StatusMarker status={round.status} />
        <span className="chat-tool-activity-phrase">{round.label}</span>
        <CaretRight
          className="chat-tool-activity-caret"
          data-open={open}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="chat-tool-activity-rows">
          {rows.map((row) => (
            <ToolActivityLine key={row.key} row={row} indented />
          ))}
        </div>
      ) : null}
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
    <div className="chat-tool-activity chat-tool-activity-live" role="status">
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
