import {
  responsesAdapterFactory,
  type ResponsesHooks,
  type ResponsesQuirks,
} from "@corbits/openai-responses";
import type { AdapterFactory } from "@intx/inference";
import {
  CODEX_ACCOUNT_ID_OPTION,
  CODEX_ORIGINATOR,
  CODEX_REASONING_EFFORT_OPTION,
  CODEX_RESPONSES_PATH,
  CODEX_SESSION_ID_OPTION,
} from "./constants";
import { wrapCodexBridgeMessage } from "./instructions";
import { parseCodexQuirks, type CodexQuirks } from "./quirks";

// `store` and `parallelToolCalls` need an explicit `false` on the wire, and
// `maxOutputTokens: false` because the backend 400s on `max_output_tokens`.
function codexResponsesQuirks(): ResponsesQuirks {
  return {
    path: CODEX_RESPONSES_PATH,
    headers: {
      static: {
        "openai-beta": "responses=experimental",
        originator: CODEX_ORIGINATOR,
      },
      fromOption: [
        { optionKey: CODEX_ACCOUNT_ID_OPTION, header: "chatgpt-account-id" },
      ],
    },
    sessionIdOption: CODEX_SESSION_ID_OPTION,
    sessionIdHeader: "session_id",
    systemPrompt: { role: "developer", shape: "parts" },
    contentShape: "typed",
    store: false,
    parallelToolCalls: false,
    maxOutputTokens: false,
    reasoning: {
      effortOption: CODEX_REASONING_EFFORT_OPTION,
    },
  };
}

// `reasoning.effort` is suppressed for "none" because ChatGPT Codex rejects
// `summary: "auto"` for some model families (HTTP 400), and the CLI's own
// default reasoning summary is "none", so no `summary` field is sent at all.
function codexResponsesHooks(quirks: CodexQuirks): ResponsesHooks {
  return {
    wrapSystemPrompt: (systemPrompt: string) =>
      wrapCodexBridgeMessage(systemPrompt, quirks),
    includeReasoningEffort: (effort: string) => effort !== "none",
  };
}

/**
 * `AdapterFactory` for Codex's Responses-speaking ChatGPT backend. `quirks`
 * is this package's own {@link CodexQuirks} (an `InferenceSource.quirks`
 * bag) carrying the host identity `wrapCodexBridgeMessage` needs; unlike
 * `@corbits/openai-responses`'s own quirks, an absent bag is a validation
 * error rather than a default, since there is no honest generic product
 * name to fall back to. This shape — `(source, quirks?)` — is what makes
 * the adapter loadable from an Interchange `AdapterManifest` entry.
 */
export const createCodexResponsesAdapter: AdapterFactory = (source, quirks) => {
  const parsed = parseCodexQuirks(quirks);
  return responsesAdapterFactory(
    codexResponsesQuirks(),
    codexResponsesHooks(parsed),
  )(source);
};
