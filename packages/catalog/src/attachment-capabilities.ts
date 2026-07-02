import { ATTACHMENT_ALLOWLIST } from "@intx/types";
import type { ModelPlugin } from "./catalog";

// What an agent can actually reason over is set by its inference ADAPTER, not
// just its model. The anthropic and google-genai adapters marshal document
// blocks (PDFs) natively; the openai / openai-compatible adapter throws on any
// document block and opencode-zen rejects the `file` content part outright, so
// those paths are images-only — and only when the model is vision-capable.
export const ATTACHMENT_CAPABILITIES = [
  "images+pdf",
  "images-only",
  "none",
] as const;
export type AttachmentCapability = (typeof ATTACHMENT_CAPABILITIES)[number];

const VISION_MODEL_PREFIXES = ["claude-", "gpt-", "gemini-", "kimi-"];

export function isVisionModel(model: string): boolean {
  return VISION_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

export function attachmentCapability(
  plugin: ModelPlugin,
  model: string,
): AttachmentCapability {
  if (plugin === "anthropic" || plugin === "google-genai") {
    return "images+pdf";
  }
  if (isVisionModel(model)) {
    return "images-only";
  }
  return "none";
}

const IMAGE_MIME_TYPES: string[] = Object.entries(ATTACHMENT_ALLOWLIST)
  .filter(([, category]) => category === "image")
  .map(([mime]) => mime);

export function acceptedMimeTypes(capability: AttachmentCapability): string[] {
  if (capability === "none") {
    return [];
  }
  if (capability === "images-only") {
    return [...IMAGE_MIME_TYPES];
  }
  return [...IMAGE_MIME_TYPES, "application/pdf"];
}
