// Lets the e2e project typecheck the web client sources it exercises: the
// app covers side-effect CSS imports via `vite/client` and worker `?raw`
// bundle-text imports via `packages/worker/src/raw-module.d.ts`, neither of
// which is in this project's include.
declare module "*.css";
declare module "*?raw" {
  const content: string;
  export default content;
}
