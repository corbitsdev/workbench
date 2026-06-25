import { createAuthClient } from "better-auth/client";

const baseURL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

export const authClient = createAuthClient({
  baseURL,
  fetchOptions: {
    credentials: "include",
  },
});

export const { signIn, signOut, useSession } = authClient;
