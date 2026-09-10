// The tool-surface manifest a packed `@corbits/*-tools` tarball carries
// in its synthesized `package.json`. The packer derives it from the
// package's own source at pack time; the hub reads it back out of the
// installed `corbits-tools` asset (see `./surface-reader.ts`) to mint
// `tool:<qualifiedId>` grants — no source imports on the hub side.
import { type } from "arktype";

export const ToolSurfaceEntry = type({
  qualifiedId: "string",
  kind: "'tool' | 'skill'",
  "approval?": "'ask'",
});
export type ToolSurfaceEntry = typeof ToolSurfaceEntry.infer;

// A qualifiedId is the binding/delivery key the workflow child's authz
// gate matches grants against, so a duplicate within one manifest is a
// defect the parse boundary must reject rather than collapse silently —
// the same invariant `ToolCredentialDeclarationArray` enforces for
// credential handles.
export const ToolSurfaceManifest = type({
  name: "string",
  version: "string",
  surface: ToolSurfaceEntry.array().narrow((entries, ctx) => {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.qualifiedId)) {
        return ctx.mustBe(
          `an array with no duplicate qualifiedIds; "${entry.qualifiedId}" appears more than once`,
        );
      }
      seen.add(entry.qualifiedId);
    }
    return true;
  }),
});
export type ToolSurfaceManifest = typeof ToolSurfaceManifest.infer;
