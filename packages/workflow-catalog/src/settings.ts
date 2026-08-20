// The `template/*` workbench-settings vocabulary: what a room minted
// from a template persists about that fact, so the shell can render
// its setup state (which connections still need connecting) without a
// second round trip. `@corbits/chat`'s settings route validates only
// its own `chat/*` keys and passes any other namespace through opaquely
// (see `packages/chat/src/workbench-settings.ts`) — this schema is the
// boundary check a caller runs before a `template/*` patch ever leaves
// the client, matching the "parse at every trust boundary" rule for a
// namespace `chat` deliberately leaves to its owner.
import { type } from "arktype";

export const TemplateSettingsPatch = type({
  "template/id": "string > 0",
  "template/pendingConnections": "string[]",
});
export type TemplateSettingsPatch = typeof TemplateSettingsPatch.infer;

/** Builds and validates the settings patch a freshly instantiated
 * template writes onto its workbench. Throws on a malformed id or
 * connections list rather than sending bad data to the wire. */
export function templateSettingsPatch(
  templateId: string,
  pendingConnections: readonly string[],
): TemplateSettingsPatch {
  const patch = {
    "template/id": templateId,
    "template/pendingConnections": [...pendingConnections],
  };
  const parsed = TemplateSettingsPatch(patch);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid template settings patch: ${parsed.summary}`);
  }
  return parsed;
}

/**
 * The `github` connect card's own settled state (CL-6345): once a
 * person has picked which repos to review, `./connect-github-setup.ts`
 * writes both keys in the same patch — `pendingConnections` with
 * `"github"` removed (this template needs nothing else, so that leaves
 * it empty) and `selectedRepos` naming exactly what got a live webhook
 * trigger. This patch rides the same `chat/*` settings PATCH route
 * every other `template/*` write does, so the room's existing
 * `chat.settings` stream event is what a connect-github card folds its
 * connected state from — no bespoke event, no refetch.
 */
export const TemplateReposSettingsPatch = type({
  "template/pendingConnections": "string[]",
  "template/selectedRepos": "string[]",
});
export type TemplateReposSettingsPatch =
  typeof TemplateReposSettingsPatch.infer;

/** Builds and validates the settings patch that records which repos a
 * room's GitHub connect card started reviewing. Throws on a malformed
 * repo id list rather than sending bad data to the wire. */
export function templateReposSettingsPatch(
  pendingConnections: readonly string[],
  selectedRepoIds: readonly string[],
): TemplateReposSettingsPatch {
  const patch = {
    "template/pendingConnections": [...pendingConnections],
    "template/selectedRepos": [...selectedRepoIds],
  };
  const parsed = TemplateReposSettingsPatch(patch);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid template repos settings patch: ${parsed.summary}`);
  }
  return parsed;
}
