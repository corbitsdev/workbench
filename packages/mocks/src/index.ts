// @corbits/mocks deliberately has no barrel export. Each provider mock is
// its own subpath (`@corbits/mocks/ollama`, with `./openai` and
// `./anthropic` to follow) so a consumer never pulls in a provider it
// isn't mocking. This root module exists only so a bare
// `import("@corbits/mocks")` resolves for tooling that expects every
// workspace package to have one (`check:packages`); it exports nothing.
export {};
