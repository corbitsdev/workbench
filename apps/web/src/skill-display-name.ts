// Person-facing title for a skill roster/detail surface. The registry id
// stays the kebab slug; what a person reads is either an explicit
// `displayTitle` or a Title Case reading of that slug (CL-6747).
import { humanizeSlug } from "@corbits/chat/display-name";

export function skillDisplayName(skill: {
  readonly name: string;
  readonly displayTitle?: string | null;
}): string {
  const titled = skill.displayTitle?.trim();
  if (titled !== undefined && titled !== "") return titled;
  return humanizeSlug(skill.name);
}
