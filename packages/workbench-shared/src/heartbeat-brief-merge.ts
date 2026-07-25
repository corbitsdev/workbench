import {
  heartbeatIntakeStepKey,
  WIRED_BRIEF_SOURCES,
} from "./preferences-registry";
import { parseToleranceEnvelope, toleranceFailureContent } from "./tolerance-envelope";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse one intake step's stored tool envelope into source-shaped JSON for
 * the brief. Two wire shapes reach here: the legacy `nonFatal`-degraded
 * shape (a plain-text outer `isError: true`, handled below before delegating
 * to the shared tolerance-envelope parser), and the CL-4464 native-action
 * shape every real `heartbeat_intake_source` step now produces — outer
 * `isError` always false, a failure nested in `content` as `{ isError: true,
 * error }` (`@workbench/shared`'s `parseToleranceEnvelope`).
 */
export function parseBriefSourceToolEnvelope(
  stepOutput: unknown,
): Record<string, unknown> {
  if (!isRecord(stepOutput)) {
    return { skipped: true, reason: "missing intake output" };
  }
  if (stepOutput.isError === true) {
    const raw = stepOutput.content;
    if (typeof raw === "string" && raw.length > 0) {
      return toleranceFailureContent(raw);
    }
    if (isRecord(raw) && typeof raw.error === "string") {
      return toleranceFailureContent(raw.error);
    }
    return toleranceFailureContent("source unavailable");
  }
  const parsed = parseToleranceEnvelope(stepOutput.content);
  if (!parsed.ok) {
    return toleranceFailureContent(parsed.error);
  }
  if (parsed.data === undefined) {
    return {};
  }
  if (isRecord(parsed.data)) {
    return parsed.data;
  }
  return toleranceFailureContent("non-object JSON in tool content");
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
