// The approve card renders the agent's framing plus fixed Approve/Deny
// buttons — never agent-authored action labels. The buttons stay disabled
// until the in-chat approval round-trip lands; the decision itself always
// belongs to the platform approval the block references.

import type { ApproveBlockData } from "@corbits/chat/blocks";

import { CHAT_STRINGS } from "../strings";
import { BlockCard, RiskBadge } from "./block-card";

export function ApproveBlockView({
  data,
}: {
  readonly data: ApproveBlockData;
}) {
  return (
    <BlockCard title={data.title}>
      {data.risk !== undefined && (
        <RiskBadge
          level={data.risk}
          label={CHAT_STRINGS.blockRiskLabel(data.risk)}
          note={data.riskNote}
        />
      )}
      {data.body !== undefined && (
        <p className="chat-block-text">{data.body}</p>
      )}
      <div className="chat-block-actions">
        <button
          type="button"
          className="chat-block-action"
          data-primary="true"
          disabled
        >
          {CHAT_STRINGS.blockApproveAction}
        </button>
        <button type="button" className="chat-block-action" disabled>
          {CHAT_STRINGS.blockDenyAction}
        </button>
      </div>
    </BlockCard>
  );
}
