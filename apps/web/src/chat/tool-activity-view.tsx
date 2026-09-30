// One collapsed row per turn: "Worked through N steps", or "Working… step N"
// while the turn is open. Expanding lists each step. The same presentation
// serves the live strip and the persisted transcript.

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
} from "@/lib/icons";
import type { ReactNode } from "react";
import { useState } from "react";

import { CHAT_STRINGS } from "./strings";
import type { ToolActivityGlyph, ToolActivityRow, ToolActivityStatus } from "./tool-activity";

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
    <span className="chat-trace-marker" data-status={status} aria-hidden="true">
      {icon}
    </span>
  );
}

function StepGlyph({ glyph }: { readonly glyph: ToolActivityGlyph }) {
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
    <span className="chat-trace-glyph" aria-hidden="true">
      {icon}
    </span>
  );
}

function TraceStep({ row }: { readonly row: ToolActivityRow }) {
  const [open, setOpen] = useState(false);
  const body = (
    <>
      <StepGlyph glyph={row.glyph} />
      <span className="chat-trace-step-text">
        {row.status === "failed" ? (
          <span className="chat-trace-sr">{CHAT_STRINGS.toolActivityFailed}. </span>
        ) : null}
        <code>{row.toolName}</code> · {row.phrase}
      </span>
      {row.meta === undefined ? <span /> : <span className="chat-trace-time">{row.meta}</span>}
      <StatusMarker status={row.status} />
    </>
  );
  if (row.detail === undefined) {
    return (
      <div className="chat-trace-step" data-status={row.status}>
        {body}
      </div>
    );
  }
  return (
    <div data-status={row.status}>
      <button
        type="button"
        className="chat-trace-step chat-trace-step-button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {body}
      </button>
      {open ? <p className="chat-trace-detail">{row.detail}</p> : null}
    </div>
  );
}

// Plus the two things that only exist while a turn is open: thinking and
// a retried request.
export function ToolTrace({
  rows,
  live = false,
  thinking = false,
  retryCount = 0,
}: {
  readonly rows: readonly ToolActivityRow[];
  readonly live?: boolean;
  readonly thinking?: boolean;
  readonly retryCount?: number;
}) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0 && !thinking && retryCount === 0) return null;
  return (
    <div className="chat-trace" data-open={open} data-live={live} data-slot="tool-activity">
      <button
        type="button"
        className="chat-trace-sum"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <CaretRight className="chat-trace-chev" aria-hidden="true" />
        {live ? <span className="chat-trace-signal" aria-hidden="true" /> : null}
        <span>
          {live ? CHAT_STRINGS.traceWorking(rows.length) : CHAT_STRINGS.traceWorked(rows.length)}
        </span>
      </button>
      {open ? (
        <div className="chat-trace-steps">
          {rows.map((row) => (
            <TraceStep key={row.key} row={row} />
          ))}
          {thinking ? (
            <div className="chat-trace-note chat-trace-thinking">
              {CHAT_STRINGS.turnActivityThinking}
            </div>
          ) : null}
          {retryCount > 0 ? (
            <div className="chat-trace-note chat-trace-retry">
              {CHAT_STRINGS.turnActivityRetry(retryCount)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
