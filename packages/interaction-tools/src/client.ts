// The one workflow-run-authenticated surface `ask_user` reaches:
// `@corbits/chat`'s `createWorkflowParticipantRoutes`'
// `POST .../participants/messages` — the generic "post a message into my
// own channel" route the same bundle family (`@corbits/agent-directory-tools`)
// already reaches for `participants/invite`. Same auth-header shape, same
// error-handling pattern as `@corbits/agent-directory-tools`'s `client.ts`.
import { type } from "arktype";

export interface AskUserClientConfig {
  readonly hubChatUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface AskUserQuestion {
  readonly question: string;
  readonly subtitle?: string;
  readonly options: readonly string[];
  readonly allowFreeText?: boolean;
}

function authHeaders(config: AskUserClientConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
  };
}

function errorMessageFrom(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    return undefined;
  }
  const error = (body as { error: unknown }).error;
  if (error === null || typeof error !== "object" || !("message" in error)) {
    return undefined;
  }
  const message = (error as { message: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  return errorMessageFrom(body) ?? fallback;
}

/** Thrown when the caller's run has no channel of its own to post into —
 * the workflow-participant route's "not a participant of any channel" 404. */
export class NoOwnChannelError extends Error {}

const PostedMessageResponse = type({ id: "string", createdAt: "string" });

/**
 * Posts a `question` block into the caller's own channel. Mints the
 * block's `questionId` here (never trusts the model to supply a stable,
 * collision-free id) and returns it, since `ask_user`'s tool result names
 * it so a caller can correlate a later answer, and the route persists
 * responses keyed by `(messageId, blockId)`. `@intx/hub-common`'s
 * `generateId` is a closed enum of platform id kinds (vendored, read-only
 * source) with no "question" entry, so this mints its own `q_`-prefixed
 * id the same way `packages/chat/src/threads.ts`'s `thr_` ids do.
 */
export async function postQuestion(
  config: AskUserClientConfig,
  question: AskUserQuestion,
): Promise<{ readonly messageId: string; readonly questionId: string }> {
  const doFetch = config.fetchImpl ?? fetch;
  const questionId = `q_${crypto.randomUUID().replace(/-/g, "")}`;
  const response = await doFetch(
    `${config.hubChatUrl}/api/workflow-chat/participants/messages`,
    {
      method: "POST",
      headers: { ...authHeaders(config), "content-type": "application/json" },
      body: JSON.stringify({
        parts: [
          {
            kind: "block",
            block: {
              type: "question",
              data: {
                questionId,
                question: question.question,
                ...(question.subtitle !== undefined
                  ? { subtitle: question.subtitle }
                  : {}),
                options: question.options,
                ...(question.allowFreeText !== undefined
                  ? { allowFreeText: question.allowFreeText }
                  : {}),
              },
            },
          },
        ],
      }),
    },
  );
  if (response.status === 404) {
    throw new NoOwnChannelError(
      await readErrorMessage(
        response,
        "The caller has no channel of its own to post into",
      ),
    );
  }
  if (!response.ok) {
    throw new Error(
      `Posting the question failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = PostedMessageResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Post-message response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return { messageId: parsed.id, questionId };
}
