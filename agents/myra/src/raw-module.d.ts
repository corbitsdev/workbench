// Vite's `?raw` suffix yields a module's source text; nothing in the
// toolchain declares it for this package.
declare module "*?raw" {
  const content: string;
  export default content;
}
