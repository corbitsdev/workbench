/** Myra composer voice dictation is opt-in at build time until the flow is stable. */

export type MyraVoiceBuildEnv = {
  readonly VITE_MYRA_VOICE_INPUT?: string;
};

export function isMyraVoiceInputBuildEnabled(
  env: MyraVoiceBuildEnv = import.meta.env,
): boolean {
  return env.VITE_MYRA_VOICE_INPUT === "true";
}

/**
 * Effective voice availability: build flag and per-user preference (local only).
 * When the build supports voice, users default to on until they opt out (`"false"`).
 */
export function isMyraVoiceInputEnabled(
  userPrefRaw: string | null,
  env: MyraVoiceBuildEnv = import.meta.env,
): boolean {
  if (!isMyraVoiceInputBuildEnabled(env)) return false;
  return userPrefRaw !== "false";
}