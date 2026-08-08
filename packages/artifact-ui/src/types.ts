// The row a Library page renders. The hub exposes no artifact store yet
// (see `apps/web/src/pages/library-page.tsx`), so this schema is the seam a
// future `/api/.../artifacts` response gets validated against — not a mirror
// of any endpoint that exists today.

import { type } from "arktype";

export const ArtifactSummary = type({
  id: "string",
  title: "string",
  /** Open vocabulary, owned by whatever produced the artifact — "deck",
   * "csv", "one-pager". Never a closed union: the hub cannot enumerate every
   * kind a workflow might one day emit. */
  kind: "string",
  ownerName: "string | null",
  createdAt: "string",
  "updatedAt?": "string | null",
});

export type ArtifactSummary = typeof ArtifactSummary.infer;
