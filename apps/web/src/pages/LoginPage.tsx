import { useState } from "react";
import { LoginView } from "../components/auth/LoginView";
import {
  type EmailPasswordCredentials,
  type OAuthProviderId,
} from "../components/auth/types";
import { authClient } from "../lib/auth-client";

export function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleOAuth = async (provider: OAuthProviderId) => {
    setLoading(true);
    setError(null);
    try {
      await authClient.signIn.social({
        provider,
        callbackURL: window.location.origin,
      });
    } catch {
      setError("Failed to sign in with Google. Please try again.");
      setLoading(false);
    }
  };

  const handleEmailPassword = async ({
    email,
    password,
  }: EmailPasswordCredentials) => {
    setLoading(true);
    setError(null);
    try {
      const result = await authClient.signIn.email({
        email,
        password,
        callbackURL: window.location.origin,
      });
      if (result.error) {
        setError(result.error.message ?? "Invalid email or password.");
        setLoading(false);
      }
    } catch {
      setError("Sign in failed. Please try again.");
      setLoading(false);
    }
  };

  return (
    <LoginView
      state={{ loading, error }}
      onOAuth={handleOAuth}
      onEmailPassword={handleEmailPassword}
    />
  );
}
