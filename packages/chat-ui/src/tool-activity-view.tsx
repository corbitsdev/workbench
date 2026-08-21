// How a turn's tool calls sit in the conversation.
//
// One presentation serves both the live strip (`turn-activity.tsx`) and the
// persisted transcript (`timeline.tsx`), so a call that reads one way while
// it runs doesn't restyle itself the moment the turn ends. Chips, not
// collapsibles: a provider tile, one sentence, a status marker, and — only
// when there is something to show — a disclosure onto plain-text detail.
// Calls stack one per call; nothing here ever folds several into a count.
// The sentences come from `tool-activity.ts`; nothing here formats a
// tool's own data.

import { CaretRight } from "@corbits/icons";
import { useState } from "react";

import { CHAT_STRINGS } from "./strings";
import {
  providerTile,
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

/** The chip's leading brand mark — 22×22, provider-colored, two letters.
 * Present on every chip, per §12.3's anatomy; a bare local tool gets the
 * neutral fallback tile rather than no tile at all. */
function ProviderTile({ provider }: { readonly provider: string | undefined }) {
  const tile = providerTile(provider);
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
        <ProviderTile provider={row.provider} />
        <span className="chat-tool-activity-phrase">{row.phrase}</span>
        {row.meta === undefined ? null : (
          <span className="chat-tool-activity-meta">{row.meta}</span>
        )}
        <StatusMarker status={row.status} />
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
        <ProviderTile provider={row.provider} />
        <span className="chat-tool-activity-phrase">{row.phrase}</span>
        {row.meta === undefined ? null : (
          <span className="chat-tool-activity-meta">{row.meta}</span>
        )}
        <StatusMarker status={row.status} />
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
    <div className="chat-tool-activity">
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
