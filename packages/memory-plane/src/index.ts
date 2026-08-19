export {
  CONNECTED_CREDENTIAL_PROVIDER_NAME,
  CONNECTED_CREDENTIAL_EMBED_MODEL,
  resolveConfigFromEnv,
  resolveConfigFromConnectedCredential,
  resolveConfigLexicalOnly,
  resolveMemoryConfig,
  type MemoryConfigSource,
  type MemoryConfigResolution,
  type ConnectedCredentialArgs,
  type ResolveMemoryConfigArgs,
} from "./config-resolution";

export {
  hostOnly,
  buildMemoryPlaneStatus,
  MEMORY_SETUP_OPTIONS,
  type MemoryPlaneStatus,
  type MemoryEmbedStatus,
  type MemoryRerankStatus,
  type MemoryDegradeStatus,
  type MemorySetupOption,
} from "./status";

export {
  createLazyMemoryPlane,
  type LazyMemoryPlane,
  type LazyMemoryPlaneDeps,
} from "./lazy-plane";

export {
  createMemoryStatusRoutes,
  type MemoryStatusRouteDeps,
} from "./status-route";
