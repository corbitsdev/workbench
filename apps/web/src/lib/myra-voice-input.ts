/** Myra composer voice dictation is opt-in at build time until the flow is stable. */
export function isMyraVoiceInputEnabled(): boolean {
  return import.meta.env.VITE_MYRA_VOICE_INPUT === "true";
}