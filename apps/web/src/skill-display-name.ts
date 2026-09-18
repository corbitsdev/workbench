// The registry id stays the kebab slug; a person reads an explicit
// `displayTitle`/`displayName`, or a Title Case reading of the slug.
import { humanizeSlug } from "@/chat/wire/display-name";

export function skillDisplayName(skill: {
  readonly name: string;
  readonly displayTitle?: string | null;
  readonly displayName?: string | null;
}): string {
  const titled = skill.displayTitle?.trim();
  if (titled !== undefined && titled !== "") return titled;
  const named = skill.displayName?.trim();
  if (named !== undefined && named !== "") return named;
  return humanizeSlug(skill.name);
}
