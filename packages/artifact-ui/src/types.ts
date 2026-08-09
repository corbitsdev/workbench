// The row a Library page renders. Today the web app maps tenant assets
// (`GET /api/tenants/:id/assets`) into this shape; a dedicated
// `/api/.../artifacts` endpoint would validate against the same schema.

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
