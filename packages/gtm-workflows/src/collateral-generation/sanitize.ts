import { SCAFFOLDING_TAGS } from '@workbench/prompts';

// The collateral system prompts express their structure with the prompt
// builders in @workbench/prompts (structuredSection, bulletList, the JSON
// output contract), which render XML scaffolding. Some models echo those
// wrapper tags into the generated body. Durable invariant: no prompt-scaffolding
// XML belongs in any collateral body — only the requested content. We strip the
// known scaffolding tags (and any adjacent newline/indentation they leave
// behind) while leaving every other tag untouched, so legitimate HTML such as
// <strong> and fenced code blocks survive.
const TAG_ALTERNATION = SCAFFOLDING_TAGS.map((tag) =>
  tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
).join('|');

// Match an opening, closing, or self-closing scaffolding tag (optionally with
// attributes, e.g. <field name="body">) together with any indentation before it
// and a single trailing newline after it, so removing the tag does not leave a
// blank-line residue and no global whitespace pass is needed.
const SCAFFOLDING_TAG_PATTERN = new RegExp(
  `[ \\t]*</?(?:${TAG_ALTERNATION})(?:\\s[^>]*?)?/?>[ \\t]*\\n?`,
  'gi'
);

export function stripLeakedPromptTags(body: string): string {
  return body.replace(SCAFFOLDING_TAG_PATTERN, '');
}
