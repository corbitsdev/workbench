// The signed-out surface: one screen, two modes. Sign-in leads — `bun run dev`
// seeds a default dev account, and hosted deployments already have accounts —
// with creating an account one click away in the form's footer.

import { Button } from "@corbits/react-ui";
import { LoginForm } from "@corbits/react-ui/blocks/login/login-form";
import { useEffect, useState } from "react";

import { AuthLayout } from "./auth/auth-layout";
import { fetchAuthConfig, signIn, signInSocial, signUp } from "./session";
import type { SessionUser, SocialProviderId } from "./session";

type Mode = "sign-in" | "sign-up";

const COPY = {
  "sign-in": {
    heading: "Welcome back",
    switchPrompt: "New here?",
    switchLabel: "Create an account",
  },
  "sign-up": {
    heading: "Create your account",
    switchPrompt: "Already have an account?",
    switchLabel: "Sign in",
  },
} as const;

const SOCIAL_PROVIDER_LABEL: Record<SocialProviderId, string> = {
  google: "Continue with Google",
  github: "Continue with GitHub",
};

export function AuthScreen({
  onSignedIn,
}: {
  readonly onSignedIn: (user: SessionUser) => void;
}) {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [socialProviders, setSocialProviders] = useState<
    readonly SocialProviderId[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    void fetchAuthConfig().then((providers) => {
      if (!cancelled) setSocialProviders(providers);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (credentials: {
    readonly email: string;
    readonly password: string;
  }) => {
    setBusy(true);
    setError(null);
    const result =
      mode === "sign-up"
        ? await signUp(credentials.email, credentials.password)
        : await signIn(credentials.email, credentials.password);
    if (result.ok) {
      onSignedIn(result.user);
      return;
    }
    setError(result.message);
    setBusy(false);
  };

  const submitSocial = async (provider: SocialProviderId) => {
    setBusy(true);
    setError(null);
    const result = await signInSocial(provider);
    // A successful call already navigated the browser away to the
    // provider; `result` only ever comes back non-null on failure.
    if (result !== null && !result.ok) {
      setError(result.message);
      setBusy(false);
    }
  };

  const copy = COPY[mode];
  return (
    <AuthLayout>
      <LoginForm
        heading={copy.heading}
        onSubmit={(credentials) => void submit(credentials)}
        busy={busy}
        error={error}
        footer={
          <>
            {socialProviders.length > 0 && (
              <div className="auth-social-providers">
                {socialProviders.map((provider) => (
                  <Button
                    key={provider}
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void submitSocial(provider)}
                  >
                    {SOCIAL_PROVIDER_LABEL[provider]}
                  </Button>
                ))}
              </div>
            )}
            {copy.switchPrompt}{" "}
            <button
              type="button"
              className="auth-switch"
              disabled={busy}
              onClick={() => {
                setMode(mode === "sign-up" ? "sign-in" : "sign-up");
                setError(null);
              }}
            >
              {copy.switchLabel}
            </button>
          </>
        }
      />
    </AuthLayout>
  );
}
