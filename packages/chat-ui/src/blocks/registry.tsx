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
import type { BlockResponseActions } from "./block-responses";
import { ConnectGithubBlockContainer } from "./connect-github-block-container";
import type { ConnectGithubActions } from "./connect-github-actions";
import { FormBlockView } from "./form-block";
import { MetricsBlockView } from "./metrics-block";
import { PollBlockView } from "./poll-block";
import { QuestionBlockView } from "./question-block";
import { StepsBlockView } from "./steps-block";
import { StreamBlockView } from "./stream-block";

function renderKnownBlock(
  block: Block,
  messageId: string,
  approvalActions: ApprovalActions | undefined,
  blockResponses: BlockResponseActions | undefined,
  connectGithubActions: ConnectGithubActions | undefined,
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
      return (
        <PollBlockView
          data={block.data}
          messageId={messageId}
          {...(blockResponses !== undefined ? { actions: blockResponses } : {})}
        />
      );
    case "form":
      return (
        <FormBlockView
          data={block.data}
          messageId={messageId}
          {...(blockResponses !== undefined ? { actions: blockResponses } : {})}
        />
      );
    case "stream":
      return <StreamBlockView data={block.data} />;
    case "question":
      return (
        <QuestionBlockView
          data={block.data}
          messageId={messageId}
          {...(blockResponses !== undefined ? { actions: blockResponses } : {})}
        />
      );
    case "connect-github":
      return (
        <ConnectGithubBlockContainer
          data={block.data}
          messageId={messageId}
          {...(connectGithubActions !== undefined
            ? { actions: connectGithubActions }
            : {})}
        />
      );
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
  messageId,
  approvalActions,
  blockResponses,
  connectGithubActions,
}: {
  readonly block: BlockPart["block"];
  /** The message this block part lives in -- polls and forms scope every
   * response to (messageId, blockId), never `blockId` alone (see
   * `packages/chat/src/block-responses.ts`). */
  readonly messageId: string;
  /** Host-supplied approve/deny round-trip; only the "approve" block reads
   * it. Absent means the pre-round-trip fixed-disabled framing. */
  readonly approvalActions?: ApprovalActions;
  /** Host-supplied poll/form round-trip; only "poll" and "form" blocks read
   * it. Absent means the pre-round-trip fixed-disabled framing. */
  readonly blockResponses?: BlockResponseActions;
  /** Host-supplied connect/list-repos/start-reviewing round-trip; only the
   * "connect-github" block reads it. Absent means the pre-round-trip
   * disconnected framing. */
  readonly connectGithubActions?: ConnectGithubActions;
}) {
  const result = parseBlock(block);
  if (!result.ok) {
    return <UnsupportedBlock type={result.type} />;
  }
  return renderKnownBlock(
    result.block,
    messageId,
    approvalActions,
    blockResponses,
    connectGithubActions,
  );
}
