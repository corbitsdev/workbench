import type { Transport } from "@intx/hub-client";

/** A captured inline image from the agent's response stream. */
export interface CapturedImage {
  mimeType: string;
  data: string;
}

export interface ImageTracker {
  /** Base64 images captured from the current turn. Empty when nothing is streaming. */
  readonly images: CapturedImage[];
  /** Tears down the underlying event subscription. */
  stop: () => void;
}

const TURN_END_EVENTS = new Set([
  "turn.committed",
  "reactor.abort",
  "reactor.error",
  "inference.error",
]);

function parseImageOutputEvent(raw: unknown): CapturedImage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { type, data } = raw as { type?: unknown; data?: unknown };
  if (type !== "inference.image_output") return null;
  if (typeof data !== "object" || data === null) return null;
  const { image } = data as { image?: unknown };
  if (typeof image !== "object" || image === null) return null;
  const { source } = image as { source?: unknown };
  if (typeof source !== "object" || source === null) return null;
  const {
    kind,
    mimeType,
    data: imgData,
  } = source as {
    kind?: unknown;
    mimeType?: unknown;
    data?: unknown;
  };
  if (kind !== "base64") return null;
  if (typeof mimeType !== "string") return null;
  if (typeof imgData !== "string") return null;
  return { mimeType, data: imgData };
}

function isTurnEndEvent(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const { type } = raw as { type?: unknown };
  return typeof type === "string" && TURN_END_EVENTS.has(type);
}

export function createImageTracker(
  transport: Transport,
  params: { tenantId: string; instanceId: string },
  onUpdate?: () => void,
): ImageTracker {
  let images: CapturedImage[] = [];
  const path = `/api/tenants/${params.tenantId}/agents/instances/${params.instanceId}/events`;

  const stop = transport.subscribe(
    path,
    (raw) => {
      const image = parseImageOutputEvent(raw);
      if (image !== null) {
        images = [...images, image];
        onUpdate?.();
        return;
      }

      if (isTurnEndEvent(raw) && images.length > 0) {
        images = [];
        onUpdate?.();
      }
    },
    { eventName: "agent.event" },
  );

  return {
    get images() {
      return images;
    },
    stop,
  };
}
