// Everything the hub needs to mount this package: migrations, store,
// apply/capture, and routes. No React here — mirrors
// `@corbits/preferences` and `@corbits/routines`, which keep their own
// `index.ts` free of anything React-shaped. The two UI components (an
// "Apply a profile" affordance and the workspace-level management list)
// live in the sibling `@corbits/config-profiles-ui` package instead of
// here, the same client/server package split `@corbits/settings-ui`
// (React) and `@corbits/preferences` (routes) already demonstrate — a
// single package mixing a Hono route module with React components would
// need both a server `types: ["bun"]` tsconfig and a browser `lib: DOM`
// one at once, which this repo's existing packages never do.
export {
  applyConfigProfilesMigrations,
  configProfilesMigrations,
  type ApplyConfigProfilesMigrationsReport,
  type ConfigProfilesMigration,
} from "./migrations";
export {
  configProfile,
  configProfilesSchema,
  type ConfigProfileTableRow,
} from "./schema";
export {
  createDrizzleConfigProfileStore,
  createInMemoryConfigProfileStore,
  type ConfigProfileDb,
  type ConfigProfileEntry,
  type ConfigProfileRow,
  type ConfigProfileStore,
  type CreateConfigProfileInput,
  type UpdateConfigProfileInput,
} from "./store";
export {
  applyProfile,
  planApply,
  ConfigProfileNotFoundError,
  type ApplyEntryResult,
  type ApplyProfileInput,
  type ApplyProfileResult,
} from "./apply";
export {
  buildProfileEntriesFromWorkbench,
  captureProfileFromWorkbench,
  type CaptureProfileInput,
} from "./capture";
export {
  createConfigProfileRoutes,
  type CreateConfigProfileRoutesDeps,
} from "./routes";
