// Test environment setup — sets minimum required env vars so config.ts and
// inference.ts can be loaded without throwing during module evaluation.
// Values are intentionally fake; tests mock the modules that use them.

process.env["PORT"] ??= "4000";
process.env["DATABASE_URL"] ??= "postgres://test:test@localhost:5432/test";
process.env["ENCRYPTION_KEYS"] ??=
  `1:${Buffer.alloc(32, 0x01).toString("base64")}`;
process.env["CLERK_SECRET_KEY"] ??= "test_clerk_key";
process.env["OPENAI_COMPATIBLE_BASE_URL"] ??= "https://api.openai.com/v1";
process.env["OPENAI_COMPATIBLE_API_KEY"] ??= "test_api_key";
process.env["OPENAI_COMPATIBLE_MODEL"] ??= "gpt-4o";
