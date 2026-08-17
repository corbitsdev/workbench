// Builds the `BlockResponseActions` port `ChatWorkspace` (`@corbits/chat-ui`)
// calls for its in-chat poll/form cards, mirroring `createChatApprovalActions`
// in `./approval-actions.ts`: `@corbits/chat-ui` owns no session, so the host
// supplies the concrete fetches against `@corbits/chat`'s own response
// routes (`getBlockResponses`/`submitPollResponse`/`submitFormResponse` in
// `api.ts`).

import type {
  BlockResponseActions,
  BlockResponseSubmitResult,
} from "@corbits/chat-ui";
import {
  ChatApiError,
  getBlockResponses,
  submitFormResponse,
  submitPollResponse,
  submitQuestionResponse,
} from "@corbits/chat-ui";

export function createChatBlockResponseActions(
  tenantId: string,
  channelId: string,
): BlockResponseActions {
  async function submit(
    call: () => Promise<void>,
  ): Promise<BlockResponseSubmitResult> {
    try {
      await call();
      return { kind: "submitted" };
    } catch (cause) {
      if (cause instanceof ChatApiError && cause.status === 403) {
        return {
          kind: "forbidden",
          message:
            "You do not have permission to respond in this conversation.",
        };
      }
      return {
        kind: "error",
        message: cause instanceof Error ? cause.message : "Couldn't submit.",
      };
    }
  }

  return {
    async getResponses(messageId, blockId) {
      try {
        const result = await getBlockResponses(
          tenantId,
          channelId,
          messageId,
          blockId,
        );
        return {
          kind: "ready",
          tally: result.tally,
          total: result.total,
          own: result.own,
        };
      } catch (cause) {
        if (cause instanceof ChatApiError && cause.status === 403) {
          return { kind: "forbidden" };
        }
        return {
          kind: "error",
          message:
            cause instanceof Error ? cause.message : "Couldn't load responses.",
        };
      }
    },
    submitPoll(messageId, blockId, choiceIds) {
      return submit(() =>
        submitPollResponse(tenantId, channelId, messageId, blockId, choiceIds),
      );
    },
    submitForm(messageId, blockId, values) {
      return submit(() =>
        submitFormResponse(tenantId, channelId, messageId, blockId, values),
      );
    },
    submitQuestion(messageId, blockId, answer, optionIndex) {
      return submit(() =>
        submitQuestionResponse(
          tenantId,
          channelId,
          messageId,
          blockId,
          answer,
          optionIndex,
        ),
      );
    },
  };
}
