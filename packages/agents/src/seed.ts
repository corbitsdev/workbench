// Narrow entry point for the sidecar: re-exports only the seed resolver and its
// types. The package index barrel transitively pulls in @workbench/chat (React
// UI), which the backend sidecar runtime must not load — importing from here
// keeps the sidecar's dependency graph free of frontend packages (CL-1952).
export {
  PERSONAL_AGENT_SEED_FILES,
  buildSeedMarker,
  parseSeedMarker,
  stripSeedMarker,
  hasSeedMarker,
  type SeedWorkspaceFile,
  type SeedMarkerParse,
} from "./personal-agent/seed-files";
