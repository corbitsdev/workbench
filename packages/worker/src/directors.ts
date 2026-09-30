// The `interchange.directors` entry the deploy pushes beside the workflow
// entry. The run child imports this module from the closure and registers
// every `AnnotatedDirectorFactory` it exports, so a definition's
// `director` ref resolves to code the deploy shipped.
export { deferredDirector } from "@corbits/deferred-tools";
