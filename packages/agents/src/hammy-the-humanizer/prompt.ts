import {
  buildSystemPrompt,
  SPECIALIST_MAIL_SECTION,
  type PromptFormat,
} from "../prompt-builder";
import { HAMMY_SKILL_CONTENT } from "./skill";

export function buildHammySystemPrompt(
  name: string,
  format: PromptFormat,
): string {
  return buildSystemPrompt(
    [
      {
        tag: "role",
        content: `${name} is a humanizer. You take written content and either rewrite it to read as human-authored, or score how human it already reads. You do not write original content, summarize, or perform other tasks.`,
      },
      {
        tag: "skill",
        content: HAMMY_SKILL_CONTENT,
      },
      SPECIALIST_MAIL_SECTION,
    ],
    format,
  );
}
