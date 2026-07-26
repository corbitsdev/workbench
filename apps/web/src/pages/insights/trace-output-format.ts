export type TraceOutputMode = "formatted" | "raw";

export type TraceValueKind = "markdown" | "json" | "text";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function looksLikeMarkdown(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  if (/^#{1,6}\s/m.test(trimmed)) return true;
  if (/^[-*]\s/m.test(trimmed)) return true;
  if (/^\d+\.\s/m.test(trimmed)) return true;
  if (/\*\*[^*]+\*\*/.test(trimmed)) return true;
  if (/`[^`]+`/.test(trimmed)) return true;
  if (/\n\n/.test(trimmed) && /[.!?]\s/.test(trimmed)) return true;
  return false;
}

export function classifyTraceValue(value: unknown): TraceValueKind {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        JSON.parse(trimmed);
        return "json";
      } catch {
        /* fall through */
      }
    }
    if (looksLikeMarkdown(value)) return "markdown";
    return "text";
  }
  if (typeof value === "number" || typeof value === "boolean") return "text";
  if (value === null || value === undefined) return "text";
  if (Array.isArray(value) || isRecord(value)) return "json";
  return "text";
}

export function stringifyTraceValue(
  value: unknown,
  mode: TraceOutputMode,
): string {
  if (mode === "raw" && typeof value === "string") return value;
  try {
    return mode === "raw"
      ? JSON.stringify(value)
      : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function parseJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}
