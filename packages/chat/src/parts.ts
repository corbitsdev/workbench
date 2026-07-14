import type {
  ChatAttachment,
  ChatImage,
  ChatMessage,
  FilePart,
  Part,
  ToolCall,
} from "./types";

function liftToolPart(toolCall: ToolCall): Part {
  const { id, name, label, arguments: input, result, isError } = toolCall;
  if (result === undefined) {
    return {
      type: "tool",
      toolCallId: id,
      toolName: name,
      state: "pending",
      ...(input !== undefined ? { input } : {}),
      ...(label !== undefined ? { label } : {}),
    };
  }
  if (isError === true) {
    return {
      type: "tool",
      toolCallId: id,
      toolName: name,
      state: "output-error",
      errorText: result,
      ...(input !== undefined ? { input } : {}),
      ...(label !== undefined ? { label } : {}),
    };
  }
  return {
    type: "tool",
    toolCallId: id,
    toolName: name,
    state: "output-available",
    output: result,
    ...(input !== undefined ? { input } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

function liftAttachmentPart(attachment: ChatAttachment): FilePart {
  return {
    type: "file",
    mediaType: attachment.type,
    url: `blob:${attachment.blobId}`,
    filename: attachment.name,
    blobId: attachment.blobId,
    size: attachment.size,
  };
}

function liftImagePart(image: ChatImage): FilePart {
  return {
    type: "file",
    mediaType: image.mimeType,
    url: `data:${image.mimeType};base64,${image.data}`,
  };
}

/**
 * Lift a flat, legacy-shaped `ChatMessage` (`content` / `reasoning` /
 * `toolCalls` / `attachments` / `images`) into an ordered `parts` array at
 * read time.
 *
 * This is the ONLY place that performs this translation — renderers must not
 * scatter their own flat-to-parts logic. It exists purely to bridge the
 * hydrated-tier data (the hub-client contract only ever delivers a turn's
 * cumulative reasoning string and its finished tool-call array, never a true
 * interleaved event order) and dies once the write path is fully
 * parts-native.
 *
 * Hydrated-tier layout (deterministic, chosen here and documented as the
 * synthesized order for any lifted message):
 *
 *   1. reasoning part      — the turn's "thinking" phase, if any
 *   2. tool parts          — in `toolCalls` array order (the array order IS
 *                            the call order; Interchange gives us nothing
 *                            finer-grained to sort by)
 *   3. file parts: attachments, then images — attachments are persisted
 *                            references the user or agent explicitly sent;
 *                            images are inline stream output, so they sort
 *                            after the more "intentional" attachment set
 *   4. text part            — the final answer, always last
 *
 * This mirrors how the flat message already renders today (reasoning
 * disclosure above the bubble, tool narrative above the answer, answer
 * text last) — see `ReasoningDisclosure`, `ToolNarrative`, `MessageBubble` —
 * so a settled live turn and a hydrated turn produce the same default
 * transcript rendering (polish parity); the two-tier fidelity difference is
 * only visible in an expanded trace view that reads live event order
 * directly, never in this lifted array.
 *
 * Total: never throws for any valid `ChatMessage`. Empty/absent fields are
 * simply omitted from the output rather than lifted as blank parts.
 */
export function liftToParts(message: ChatMessage): Part[] {
  const parts: Part[] = [];

  const reasoning = message.reasoning?.trim();
  if (reasoning !== undefined && reasoning !== "") {
    parts.push({ type: "reasoning", text: reasoning });
  }

  for (const toolCall of message.toolCalls ?? []) {
    parts.push(liftToolPart(toolCall));
  }

  for (const attachment of message.attachments ?? []) {
    parts.push(liftAttachmentPart(attachment));
  }

  for (const image of message.images ?? []) {
    parts.push(liftImagePart(image));
  }

  const text = message.content.trim();
  if (text !== "") {
    parts.push({ type: "text", text });
  }

  return parts;
}
