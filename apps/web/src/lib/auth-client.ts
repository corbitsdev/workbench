import { createAuthClient } from "better-auth/client";

const baseURL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

export const authClient = createAuthClient({
  baseURL,
  fetchOptions: {
    credentials: "include",
  },
});

export const { signIn, signOut, useSession } = authClient;

export function oauthErrorMessage(errorCode: string | null): string | null {
  if (!errorCode) return null;
  switch (errorCode) {
    case "state_mismatch":
      return "Sign-in expired or was blocked by your browser (common on mobile). Close this tab, open the app in Safari or Chrome, and try Google sign-in again.";
    case "access_denied":
      return "Google sign-in was cancelled.";
    default:
      return "Sign-in failed. Please try again.";
  }
}
