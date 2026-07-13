import {
  heartbeatIntakeStepKey,
  WIRED_BRIEF_SOURCES,
} from "./preferences-registry";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse one intake step's stored tool envelope into source-shaped JSON for the brief. */
export function parseBriefSourceToolEnvelope(
  stepOutput: unknown,
): Record<string, unknown> {
  if (!isRecord(stepOutput)) {
    return { skipped: true, reason: "missing intake output" };
  }
  if (stepOutput.isError === true) {
    const raw = stepOutput.content;
    if (typeof raw === "string" && raw.length > 0) {
      return { isError: true, error: raw };
    }
    if (isRecord(raw) && typeof raw.error === "string") {
      return { isError: true, error: raw.error };
    }
    return { isError: true, error: "source unavailable" };
  }
  const content = stepOutput.content;
  if (typeof content === "string") {
    if (content.length === 0) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(content);
      if (isRecord(parsed)) {
        return parsed;
      }
      return { isError: true, error: "non-object JSON in tool content" };
    } catch {
      return { isError: true, error: "invalid JSON in tool content" };
    }
  }
  if (isRecord(content)) {
    return content;
  }
  return {};
}

/**
 * Build `{ sources: { granola, linear, attio, vercel } }` from projected intake
 * step records (`{ output: toolEnvelope }` per `steps.intake-<source>`).
 */
export function mergeHeartbeatBriefSources(
  projectedSteps: Record<string, unknown>,
): { sources: Record<string, Record<string, unknown>> } {
  const sources: Record<string, Record<string, unknown>> = {};
  for (const source of WIRED_BRIEF_SOURCES) {
    const stepId = heartbeatIntakeStepKey(source.key);
    const entry = projectedSteps[stepId];
    const output =
      isRecord(entry) && "output" in entry ? entry.output : undefined;
    sources[source.key] = parseBriefSourceToolEnvelope(output);
  }
  return { sources };
}
