// The library entry for `@workbench/cli`: the environment schemas the
// `setup` and `seed` verbs read. The tenant-seeding logic itself lives
// in `@workbench/hub-client`, which any other consumer (the first-login
// provisioning hook, in particular) depends on directly instead of on
// this CLI package.

export type { ModelSource, SeedConfig, SetupConfig } from "./config";
export {
  MODEL_CREDENTIAL_VARIABLES,
  readSeedConfig,
  readSetupConfig,
} from "./config";
