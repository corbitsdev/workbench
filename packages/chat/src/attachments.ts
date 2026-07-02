/**
 * Client-side attachment validation for the composer. Mirrors the hub's
 * `validateAttachments` limits so a file that would be rejected server-side is
 * caught before send with a legible message — never silently dropped
 * (apps/web/AGENTS.md). The accepted MIME set is supplied by the caller,
 * narrowed to what the active agent's adapter can actually consume.
 */

export interface AttachmentPolicy {
  acceptedMimeTypes: string[];
  perAttachmentLimitBytes: number;
  perMessageTotalLimitBytes: number;
}

// Constructed from a picked/dropped File in the browser, not parsed from a wire
// payload — a plain type, per the arktype-at-the-boundary rule.
export interface PendingAttachment {
  id: string;
  file: File;
  name: string;
  mimeType: string;
  size: number;
}

export interface ValidateResult {
  accepted: PendingAttachment[];
  errors: string[];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

export function validateFiles(
  files: readonly File[],
  policy: AttachmentPolicy,
  existing: readonly PendingAttachment[],
): ValidateResult {
  const accepted: PendingAttachment[] = [];
  const errors: string[] = [];
  let runningTotal = existing.reduce((sum, a) => sum + a.size, 0);

  for (const file of files) {
    const mimeType = file.type;
    if (!policy.acceptedMimeTypes.includes(mimeType)) {
      errors.push(
        `${file.name}: ${mimeType || "unknown type"} isn't supported here.`,
      );
      continue;
    }
    if (file.size > policy.perAttachmentLimitBytes) {
      errors.push(
        `${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(
          policy.perAttachmentLimitBytes,
        )} per-file limit.`,
      );
      continue;
    }
    if (runningTotal + file.size > policy.perMessageTotalLimitBytes) {
      errors.push(
        `${file.name} would push this message past the ${formatBytes(
          policy.perMessageTotalLimitBytes,
        )} total limit.`,
      );
      continue;
    }
    runningTotal += file.size;
    accepted.push({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      mimeType,
      size: file.size,
    });
  }

  return { accepted, errors };
}
