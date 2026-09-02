// The library entry for `@workbench/hub-client`: credential probing and
// completion-capability filtering shared by onboarding, connections, and
// tenant seeding (`@corbits/seeding`).

export {
  fetchOllamaModelCatalog,
  ollamaApiRoot,
  ollamaOpenAICompatBaseURL,
  OLLAMA_PLACEHOLDER_SECRET,
  PROVIDER_TEST_CONFIG,
  providerModelSource,
  supportedCredentialProviders,
  testProviderCredential,
} from "./credential-test";
export type {
  AdapterPluginId,
  CredentialTestResult,
  OllamaCatalogModel,
  ProviderModelSource,
  ProviderTestConfig,
  SupportedCredentialProvider,
  TestProviderCredentialArgs,
} from "./credential-test";
