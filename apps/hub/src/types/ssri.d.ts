// Workbench-side type bridge for the interchange pin (CL-2647).
//
// `interchange/packages/hub-api/src/routes/assets.ts` imports "ssri" but
// hub-api does not declare `@types/ssri`, so when our hub program compiles
// that upstream source the import is implicitly `any` (TS7016). We cannot
// modify interchange/, so surface the real `@types/ssri` declarations
// (a devDependency of this app) under the bare "ssri" specifier.
declare module "ssri" {
  const ssri: typeof import("@types/ssri");
  export default ssri;
  export * from "@types/ssri";
}
