import {
  responsesAdapterFactory,
  type ResponsesQuirks,
} from "@corbits/openai-responses";
import type { AdapterFactory } from "@intx/inference";
import {
  XAI_CLIENT_IDENTIFIER,
  XAI_CLIENT_VERSION,
  XAI_REASONING_EFFORT_OPTION,
  XAI_RESPONSES_PATH,
  XAI_SESSION_ID_OPTION,
  XAI_USER_AGENT,
  XAI_USER_ID_OPTION,
} from "./constants";

// Mirrors the grok CLI's own /v1/responses request (captured live): the
// system prompt rides as a leading `system` input message with plain string
// content (not parts), text-only turns flatten to a string, reasoning is
// always requested at "detailed" summary depth, and the caller is identified
// by x-grok-* headers rather than a body field. The proxy's own request
// never sets `parallel_tool_calls`, so this quirks bag leaves it unset
// rather than forcing it either way.
export const xaiResponsesQuirks: ResponsesQuirks = {
  path: XAI_RESPONSES_PATH,
  headers: {
    static: {
      "user-agent": XAI_USER_AGENT,
      "x-grok-client-identifier": XAI_CLIENT_IDENTIFIER,
      "x-grok-client-version": XAI_CLIENT_VERSION,
    },
    modelHeader: "x-grok-model-override",
    fromOption: [{ optionKey: XAI_USER_ID_OPTION, header: "x-grok-user-id" }],
  },
  sessionIdOption: XAI_SESSION_ID_OPTION,
  systemPrompt: { role: "system", shape: "string" },
  contentShape: "flat",
  reasoning: {
    summary: "detailed",
    effortOption: XAI_REASONING_EFFORT_OPTION,
  },
  // The proxy's own request never sends max_output_tokens or temperature;
  // the shared package forwards both by default, so both must opt out here.
  maxOutputTokens: false,
  temperature: false,
};

/**
 * `AdapterFactory` for xAI's Responses-speaking CLI chat proxy, with xAI's
 * headers, system-prompt placement, and reasoning shape baked in via
 * `@corbits/openai-responses`.
 */
export const createXaiResponsesAdapter: AdapterFactory =
  responsesAdapterFactory(xaiResponsesQuirks);
