// Person-facing title for a skill roster/detail surface. The registry id
// stays the kebab slug; what a person reads is either an explicit
// `displayTitle` (or the native skill asset's `displayName`, which the
// stock asset routes carry as of CL-8086) or a Title Case reading of that
// slug (CL-6747).
import { humanizeSlug } from "@corbits/chat-ui/wire/display-name";

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
