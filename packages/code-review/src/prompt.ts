// The one turn input every reviewer sees: the pull request's title,
// description, and per-file patches.
//
// Two budgets, because a real pull request blows past a turn otherwise —
// a 100-file change renders half a million characters of patch. Each
// patch is capped on its own, and the prompt stops adding files once the
// total budget is spent. Both cuts are stated in the prompt: a reviewer
// that was shown part of a change must know that, or it will report a
// gap it never looked at as if the change had none.
import type { PullRequestDiff } from "@corbits/github-tools";

const MAX_PATCH_CHARS = 12000;
const MAX_TOTAL_PATCH_CHARS = 120000;

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

  const rendered: string[] = [];
  const omitted: string[] = [];
  let spent = 0;
  for (const file of diff.files) {
    const heading =
      `--- ${file.path} (${file.status}, +${String(file.additions)} ` +
      `-${String(file.deletions)})`;
    if (spent >= MAX_TOTAL_PATCH_CHARS) {
      omitted.push(file.path);
      continue;
    }
    const body =
      file.patch === undefined
        ? "(no patch available for this file)"
        : renderPatch(file.patch);
    spent += body.length;
    rendered.push(`${heading}\n${body}`);
  }

  const tail =
    omitted.length === 0
      ? ""
      : `\nNot shown to you (the change is too large for one turn): ` +
        `${omitted.join(", ")}. Say that these files were not shown ` +
        "rather than reviewing them unseen.\n";

  return `${header}Diff:\n${rendered.join("\n\n")}\n${tail}`;
}
