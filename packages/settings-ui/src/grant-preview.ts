// Live plain-language sentence for the Add grant dialog. Pure so the
// dialog can recompute on every field change without a side effect, and
// so the unit test can pin the wording without rendering React.

export type GrantPreviewInput = {
  readonly targetLabel: string | null;
  readonly resource: string;
  readonly action: string;
  readonly effect: "allow" | "deny" | "ask";
  readonly expiresLabel: string | null;
};

export function grantPreviewSentence(input: GrantPreviewInput): string {
  const who =
    input.targetLabel === null || input.targetLabel.trim().length === 0
      ? "Someone"
      : input.targetLabel.trim();
  const verb =
    input.effect === "allow"
      ? "may"
      : input.effect === "deny"
        ? "must not"
        : "must ask before they can";
  const base = `${who} ${verb} ${input.action} on ${input.resource}`;
  if (input.expiresLabel === null || input.expiresLabel.trim().length === 0) {
    return `${base}.`;
  }
  return `${base}, until ${input.expiresLabel.trim()}.`;
}

export function expiryIsoFromPreset(
  preset: "never" | "24h" | "7d" | "30d",
  now: Date = new Date(),
): string | null {
  if (preset === "never") return null;
  const ms =
    preset === "24h"
      ? 24 * 60 * 60 * 1000
      : preset === "7d"
        ? 7 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() + ms).toISOString();
}

export function expiryLabelFromPreset(
  preset: "never" | "24h" | "7d" | "30d",
): string | null {
  if (preset === "never") return null;
  if (preset === "24h") return "in 24 hours";
  if (preset === "7d") return "in 7 days";
  return "in 30 days";
}
