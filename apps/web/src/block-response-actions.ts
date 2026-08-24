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
  CHAT_STRINGS,
  ChatApiError,
  getBlockResponses,
  submitFormResponse,
  submitPollResponse,
  submitQuestionResponse,
} from "@corbits/chat-ui";

export function createChatBlockResponseActions(
  tenantId: string,
  workbenchId: string,
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
          message: CHAT_STRINGS.blockApproveActionForbidden,
        };
      }
      return {
        kind: "error",
        message:
          cause instanceof Error
            ? cause.message
            : CHAT_STRINGS.blockFormSubmitError,
      };
    }
  }

  return {
    async getResponses(messageId, blockId) {
      try {
        const result = await getBlockResponses(
          tenantId,
          workbenchId,
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
        submitPollResponse(
          tenantId,
          workbenchId,
          messageId,
          blockId,
          choiceIds,
        ),
      );
    },
    submitForm(messageId, blockId, values) {
      return submit(() =>
        submitFormResponse(tenantId, workbenchId, messageId, blockId, values),
      );
    },
    submitQuestion(messageId, blockId, answer, optionIndex) {
      return submit(() =>
        submitQuestionResponse(
          tenantId,
          workbenchId,
          messageId,
          blockId,
          answer,
          optionIndex,
        ),
      );
    },
  };
}
