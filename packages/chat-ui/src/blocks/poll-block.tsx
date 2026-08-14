// Poll choices render with vote tallies from the server's own aggregation
// -- never from anything in `PollBlockData`, which carries no counts at
// all (see `packages/chat/src/blocks.ts`). The optimistic tally shown the
// instant a vote is cast is discarded the moment the real read comes back;
// nothing here is ever trusted twice.

import { useEffect, useState } from "react";
import type { PollBlockData } from "@corbits/chat/blocks";

import { CHAT_STRINGS } from "../strings";
import { BlockCard } from "./block-card";
import type {
  BlockResponseActions,
  BlockResponseQuery,
} from "./block-responses";

function ownChoiceIds(query: BlockResponseQuery): readonly string[] {
  if (query.kind !== "ready" || query.own === null) return [];
  return query.own.kind === "poll" ? query.own.choiceIds : [];
}

function toggledChoiceIds(
  current: readonly string[],
  choiceId: string,
  multi: boolean,
): readonly string[] {
  if (!multi) return [choiceId];
  return current.includes(choiceId)
    ? current.filter((id) => id !== choiceId)
    : [...current, choiceId];
}

function StaticChoices({ data }: { readonly data: PollBlockData }) {
  return (
    <div className="chat-block-choices">
      {data.choices.map((choice) => (
        <button
          key={choice.id}
          type="button"
          className="chat-block-choice"
          disabled
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

export function PollBlockView({
  data,
  messageId,
  actions,
}: {
  readonly data: PollBlockData;
  readonly messageId?: string;
  readonly actions?: BlockResponseActions;
}) {
  const [query, setQuery] = useState<BlockResponseQuery>({ kind: "loading" });
  const [voting, setVoting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (actions === undefined || messageId === undefined) return;
    let cancelled = false;
    setQuery({ kind: "loading" });
    actions.getResponses(messageId, data.pollId).then((result) => {
      if (!cancelled) setQuery(result);
    });
    return () => {
      cancelled = true;
    };
  }, [actions, messageId, data.pollId]);

  if (actions === undefined || messageId === undefined) {
    return (
      <BlockCard title={data.title}>
        <StaticChoices data={data} />
      </BlockCard>
    );
  }

  const closed =
    data.closesAt !== undefined && Date.parse(data.closesAt) <= Date.now();

  function castVote(choiceId: string) {
    if (actions === undefined || messageId === undefined || closed) return;
    const nextChoiceIds = toggledChoiceIds(
      ownChoiceIds(query),
      choiceId,
      data.multi === true,
    );
    if (nextChoiceIds.length === 0) return;
    setVoting(choiceId);
    setError(null);
    actions
      .submitPoll(messageId, data.pollId, nextChoiceIds)
      .then((result) => {
        if (result.kind !== "submitted") {
          setError(CHAT_STRINGS.blockPollVoteError);
        }
        return actions.getResponses(messageId, data.pollId).then(setQuery);
      })
      .finally(() => setVoting(null));
  }

  const tally = query.kind === "ready" ? query.tally : {};
  const total = query.kind === "ready" ? query.total : 0;
  const selected = ownChoiceIds(query);
  const loading = query.kind === "loading";

  return (
    <BlockCard title={data.title}>
      <div className="chat-block-choices">
        {data.choices.map((choice) => {
          const count = tally[choice.id] ?? 0;
          const percent = total > 0 ? Math.round((count / total) * 100) : 0;
          const isSelected = selected.includes(choice.id);
          return (
            <button
              key={choice.id}
              type="button"
              className="chat-block-choice chat-block-poll-choice"
              data-selected={isSelected}
              disabled={loading || voting !== null || closed}
              onClick={() => castVote(choice.id)}
            >
              <span className="chat-block-poll-choice-label">
                {choice.label}
                {isSelected && (
                  <span className="chat-block-poll-your-vote">
                    {CHAT_STRINGS.blockPollYourVote}
                  </span>
                )}
              </span>
              <span className="chat-block-bar" aria-hidden="true">
                <span
                  className="chat-block-bar-fill"
                  style={{ width: `${percent}%` }}
                />
              </span>
              <span className="chat-block-poll-choice-count">
                {CHAT_STRINGS.blockPollVoteCount(count)}
              </span>
            </button>
          );
        })}
      </div>
      {error !== null && (
        <p className="chat-block-text" role="alert">
          {error}
        </p>
      )}
    </BlockCard>
  );
}
