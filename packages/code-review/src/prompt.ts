// The one turn input every reviewer sees: the pull request's title,
// description, and per-file patches. Each patch is capped so a large
// change still fits one turn; a truncated patch says so in place rather
// than ending mid-hunk as if that were the whole file.
import type { PullRequestDiff } from "@corbits/github-tools";

const MAX_PATCH_CHARS = 12000;

function renderPatch(patch: string): string {
  if (patch.length <= MAX_PATCH_CHARS) return patch;
  return (
    `${patch.slice(0, MAX_PATCH_CHARS)}\n` +
    "... patch truncated; review what is shown and say that the rest " +
    "was not shown to you."
  );
}

/** Renders the review turn's input for one pull request. */
export function renderReviewPrompt(diff: PullRequestDiff): string {
  const header = [
    `Pull request: ${diff.title}`,
    `URL: ${diff.url}`,
    `Files changed: ${String(diff.files.length)}`,
    "",
    "Description:",
    diff.description.trim().length === 0
      ? "(none given)"
      : diff.description.trim(),
    "",
  ].join("\n");

  const files = diff.files.map((file) => {
    const heading =
      `--- ${file.path} (${file.status}, +${String(file.additions)} ` +
      `-${String(file.deletions)})`;
    const body =
      file.patch === undefined
        ? "(no patch available for this file)"
        : renderPatch(file.patch);
    return `${heading}\n${body}`;
  });

  return `${header}Diff:\n${files.join("\n\n")}\n`;
}
