// Preset options for the intake screen's optional audience/tone/goal
// dropdowns. Browser-safe and dependency-free (no imports) — this is the
// single shared source list for those three fields; ui.tsx renders each as a
// "pick a preset, or type your own" select and this module owns the presets.

export const AUDIENCE_OPTIONS = [
  "Prospective customer",
  "Existing customer",
  "Investor",
  "Internal team",
  "Technical evaluator",
  "Executive / decision maker",
] as const;

export const TONE_OPTIONS = [
  "Professional",
  "Conversational",
  "Confident",
  "Consultative",
  "Technical",
  "Visionary",
] as const;

export const GOAL_OPTIONS = [
  "Win the deal",
  "Educate",
  "Build trust",
  "Drive a decision",
  "Announce / launch",
  "Recap a call",
] as const;
