// The tool packages Myra's `workflow.js` closure bundles inline (see
// `index.ts`'s `MYRA_TOOL_FACTORIES`). Every deployment carries these, but
// `toolPackagePins` in the deployed `definition.json` stays empty for them
// — the factories ride the closure, not a resolved pin — so a reader of
// that file alone can't see them. This literal list is the browser-safe
// mirror a UI can import instead; it must be kept in step with this
// package's own `@intx/tools-*` dependency versions.
export type MyraToolPackage = { readonly name: string; readonly version: string };

export const MYRA_TOOL_PACKAGES: readonly MyraToolPackage[] = [
  { name: "@intx/tools-mail", version: "0.3.0" },
  { name: "@intx/tools-posix", version: "0.3.0" },
];
