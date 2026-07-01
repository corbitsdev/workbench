import type { betterAuth } from "better-auth";

// The caller's display name is identity, not a UI preference: it lives on the
// better-auth `user.name` record. We update it through the supported server API
// (`auth.api.updateUser`), which derives the target user from the session cookie
// carried in `headers` — never by touching `@intx/*` or the user table directly.
// Typing the dependency as the real better-auth instance keeps the route plain
// DI (no cast at the wiring site, like `db`); we only ever touch `api.updateUser`.
export type AuthUserUpdater = Pick<ReturnType<typeof betterAuth>, "api">;

export async function updateDisplayName(
  auth: AuthUserUpdater,
  name: string,
  headers: Headers,
): Promise<void> {
  await auth.api.updateUser({ body: { name }, headers });
}
