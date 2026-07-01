import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { LoginView } from "../components/auth/LoginView";
import { authClient, oauthErrorMessage } from "../lib/auth-client";
import {
  type EmailPasswordCredentials,
  type OAuthProviderId,
} from "../components/auth/types";

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const callbackError = useMemo(
    () => oauthErrorMessage(searchParams.get("error")),
    [searchParams],
  );
  const [error, setError] = useState<string | null>(callbackError);
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
