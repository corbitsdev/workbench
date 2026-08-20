// SKILL.md is the registry's only content format: the hub's native
// `skill` RepoKind handler (vendor/intx/hub-sessions/src/skill-kind.ts)
// walks each top-level directory of a skill asset, requires a SKILL.md
// there, and rejects the push unless the YAML frontmatter carries a
// kebab-case `name` matching the directory and a 1..1024-char
// `description` free of HTML tags.
//
// Both halves of that contract are enforced here, at this package's own
// boundary, so an author sees a plain-language rejection in the create
// dialog instead of a git push failure three layers down. The schema is
// re-declared rather than imported from the vendored handler because
// the handler exports it for its own push-validation path, not as a
// stable authoring contract — but the rules are deliberately identical,
// and a drift shows up immediately as a rejected push.
import { type } from "arktype";

export const SKILL_MD_FILENAME = "SKILL.md";

const FRONTMATTER_DELIMITER = "---";

const RESERVED_SKILL_NAMES = ["anthropic", "claude"];

export const skillNameSchema = type(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .and("string<=64")
  .narrow((name: string, ctx) => {
    if (RESERVED_SKILL_NAMES.includes(name)) {
      return ctx.mustBe(`not the reserved name "anthropic" or "claude"`);
    }
    return true;
  });

export const skillDescriptionSchema = type("1 <= string <= 1024").and(
  type(/^(?!.*<[^>]+>).*$/s),
);

export const skillFrontmatterSchema = type({
  name: skillNameSchema,
  description: skillDescriptionSchema,
}).onUndeclaredKey("ignore");

export type SkillFrontmatter = typeof skillFrontmatterSchema.infer;

export type ParsedSkillMd = {
  readonly name: string;
  readonly description: string;
  readonly body: string;
};

export class SkillContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillContentError";
  }
}

/**
 * Renders a SKILL.md the hub's skill kind handler accepts. The
 * description is emitted as a single-quoted YAML scalar so a colon or a
 * leading `#` in an author's prose cannot re-open the frontmatter as a
 * different mapping.
 */
export function buildSkillMd(input: {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}): string {
  const frontmatter = skillFrontmatterSchema({
    name: input.name,
    description: input.description,
  });
  if (frontmatter instanceof type.errors) {
    throw new SkillContentError(
      `skill frontmatter is invalid: ${frontmatter.summary}`,
    );
  }
  const body = input.body.trim();
  if (body === "") {
    throw new SkillContentError("skill body must not be empty");
  }
  const quotedDescription = `'${frontmatter.description.replace(/'/g, "''")}'`;
  return [
    FRONTMATTER_DELIMITER,
    `name: ${frontmatter.name}`,
    `description: ${quotedDescription}`,
    FRONTMATTER_DELIMITER,
    "",
    body,
    "",
  ].join("\n");
}

/**
 * Parses a SKILL.md back into the three fields the registry surfaces.
 * Fails closed: a missing or malformed frontmatter block is an error,
 * never a skill that silently reads as nameless.
 */
export function parseSkillMd(text_: string): ParsedSkillMd {
  const lines = text_.split(/\r?\n/);
  if (lines[0] !== FRONTMATTER_DELIMITER) {
    throw new SkillContentError(
      `${SKILL_MD_FILENAME} is missing its YAML frontmatter delimiter`,
    );
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === FRONTMATTER_DELIMITER) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new SkillContentError(
      `${SKILL_MD_FILENAME} frontmatter has no closing delimiter`,
    );
  }
  const yamlText = lines.slice(1, endIdx).join("\n");
  let rawFrontmatter: unknown;
  try {
    rawFrontmatter = Bun.YAML.parse(yamlText);
  } catch (cause) {
    throw new SkillContentError(
      `${SKILL_MD_FILENAME} frontmatter is not valid YAML: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  const frontmatter = skillFrontmatterSchema(rawFrontmatter);
  if (frontmatter instanceof type.errors) {
    throw new SkillContentError(
      `${SKILL_MD_FILENAME} frontmatter is invalid: ${frontmatter.summary}`,
    );
  }
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    body: lines
      .slice(endIdx + 1)
      .join("\n")
      .trim(),
  };
}

export function decodeSkillMd(bytes: Uint8Array): ParsedSkillMd {
  return parseSkillMd(new TextDecoder().decode(bytes));
}
