/**
 * Helpers for classifying agent launch states and errors so the chat UI can
 * show the right pending/connecting/failure state instead of raw error strings.
 */

const TRANSIENT_PATTERNS = [
  'No sidecar connected',
  'No sidecar available',
  'sidecar not connected',
  'sidecar not available',
];

export function isTransientLaunchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_PATTERNS.some((p) => message.includes(p));
}

const MISSING_CONFIG_PATTERNS = [
  'credential',
  'no model',
  'not configured',
  'missing configuration',
];

export function isMissingConfigError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return MISSING_CONFIG_PATTERNS.some((p) => message.includes(p));
}

export type LaunchState =
  | { kind: 'connecting' }
  | { kind: 'deploying' }
  | { kind: 'missing-config'; message: string }
  | { kind: 'fatal'; message: string };

/**
 * Map a raw launch outcome to a user-facing state.
 *
 * - `connecting`    — launch succeeded; waiting for sidecar to come up (transient)
 * - `deploying`     — instance is not yet running; transient startup delay
 * - `missing-config`— launch failed because credentials or config are absent
 * - `fatal`         — launch failed for a non-recoverable reason
 */
export function classifyLaunchState(
  instanceStatus: string | undefined,
  launchError: string | null,
): LaunchState {
  if (instanceStatus !== undefined && instanceStatus !== 'running') {
    return { kind: 'deploying' };
  }

  if (launchError === null) {
    return { kind: 'connecting' };
  }

  if (isTransientLaunchError(launchError)) {
    return { kind: 'connecting' };
  }

  if (isMissingConfigError(launchError)) {
    return { kind: 'missing-config', message: launchError };
  }

  return { kind: 'fatal', message: launchError };
}
