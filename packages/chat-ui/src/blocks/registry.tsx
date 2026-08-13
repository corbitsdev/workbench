// The closed, curated block registry: agents author data, this client owns
// the code. `BlockPartView` parses the wire envelope at the render boundary
// and routes each known type to its view; anything unknown or malformed
// renders a labeled fallback card instead of raw JSON or a crash.

import type { Block } from "@corbits/chat/blocks";
import { parseBlock } from "@corbits/chat/blocks";
import type { BlockPart } from "@corbits/chat/parts";
import type { ReactElement } from "react";

import { CHAT_STRINGS } from "../strings";
import { ApproveBlockView } from "./approve-block";
import type { ApprovalActions } from "./approval-actions";
import { FormBlockView } from "./form-block";
import { MetricsBlockView } from "./metrics-block";
import { PollBlockView } from "./poll-block";
import { StepsBlockView } from "./steps-block";
import { StreamBlockView } from "./stream-block";

function renderKnownBlock(
  block: Block,
  approvalActions: ApprovalActions | undefined,
): ReactElement {
  switch (block.type) {
    case "approve":
      return (
        <ApproveBlockView
          data={block.data}
          {...(approvalActions !== undefined
            ? { actions: approvalActions }
            : {})}
        />
      );
    case "steps":
      return <StepsBlockView data={block.data} />;
    case "metrics":
      return <MetricsBlockView data={block.data} />;
    case "poll":
      return <PollBlockView data={block.data} />;
    case "form":
      return <FormBlockView data={block.data} />;
    case "stream":
      return <StreamBlockView data={block.data} />;
  }
}

function UnsupportedBlock({ type }: { readonly type: string }) {
  return (
    <div className="chat-fallback-block">
      <span className="chat-fallback-label">
        {CHAT_STRINGS.blockUnsupportedTitle}
      </span>
      <span className="chat-fallback-body">
        {CHAT_STRINGS.blockUnsupportedBody(type)}
      </span>
    </div>
  );
}

export function BlockPartView({
  block,
  approvalActions,
}: {
  readonly block: BlockPart["block"];
  /** Host-supplied approve/deny round-trip; only the "approve" block reads
   * it. Absent means the pre-round-trip fixed-disabled framing. */
  readonly approvalActions?: ApprovalActions;
}) {
  const result = parseBlock(block);
  if (!result.ok) {
    return <UnsupportedBlock type={result.type} />;
  }
  return renderKnownBlock(result.block, approvalActions);
}
