import { type } from "arktype";
import type { ResolvedInferenceDials } from "./inference-params";

const InferenceDialSchema = "number | null";

export const InferenceParamsMarkerPayloadSchema = type({
  model: "string",
  creative: InferenceDialSchema,
  thinking: InferenceDialSchema,
});

export type InferenceParamsMarkerPayload =
  typeof InferenceParamsMarkerPayloadSchema.infer;

const MARKER_PREFIX = "<!-- workbench:inference-params=";
const MARKER_SUFFIX = " -->";

const MARKER_PATTERN_GLOBAL =
  /<!--\s*workbench:inference-params=([^>]*?)\s*-->/g;

function encodePayload(payload: InferenceParamsMarkerPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf8").toString("base64url");
}

function decodePayload(
  encoded: string,
): InferenceParamsMarkerPayload | undefined {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = InferenceParamsMarkerPayloadSchema(JSON.parse(json));
    if (parsed instanceof type.errors) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function buildInferenceParamsMarker(
  dials: ResolvedInferenceDials,
): string {
  const payload: InferenceParamsMarkerPayload = {
    model: dials.model,
    creative: dials.creative,
    thinking: dials.thinking,
  };
  return `${MARKER_PREFIX}${encodePayload(payload)}${MARKER_SUFFIX}`;
}

export function resolveInferenceParamsMarker(
  systemPrompt: string,
): ResolvedInferenceDials | undefined {
  const matches = [...systemPrompt.matchAll(MARKER_PATTERN_GLOBAL)];
  const encoded = matches.at(-1)?.[1];
  if (encoded === undefined) return undefined;
  const payload = decodePayload(encoded);
  if (payload === undefined) return undefined;
  return {
    model: payload.model,
    creative: payload.creative,
    thinking: payload.thinking,
  };
}

export function stripInferenceParamsMarker(systemPrompt: string): string {
  return systemPrompt
    .replace(MARKER_PATTERN_GLOBAL, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
