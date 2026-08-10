// Access policy block for the People section. Signup mode and allowed email
// domains are operator env (WORKBENCH_SIGNUP / WORKBENCH_SIGNUP_DOMAINS) —
// read-only here via GET /api/auth-config. Invite copy-link management is
// host-owned; this block surfaces the closed-by-default policy honestly.

import { Badge, EmptyState, Skeleton } from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { getAuthConfig, type AuthConfig } from "./api";
import { errorMessage, type LoadState } from "./load-state";
import { SETTINGS_STRINGS } from "./strings";

export function AccessPolicyBlock() {
  const [state, setState] = useState<LoadState<AuthConfig>>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    getAuthConfig()
      .then((config) => {
        if (!cancelled) setState({ kind: "ready", data: config });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({ kind: "error", message: errorMessage(cause) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") return <Skeleton className="query-skeleton" />;
  if (state.kind === "error") {
    return (
      <EmptyState
        icon={<CircleAlert />}
        title={`Couldn't load ${SETTINGS_STRINGS.accessPolicyLoadError}`}
        description={state.message}
      />
    );
  }

  return <AccessPolicyView config={state.data} />;
}

export function AccessPolicyView({
  config,
}: {
  readonly config: AuthConfig;
}) {
  const signupLabel =
    config.signupMode === "open"
      ? SETTINGS_STRINGS.accessPolicySignupOpen
      : SETTINGS_STRINGS.accessPolicySignupClosed;

  return (
    <div className="settings-access-policy">
      <h3 className="settings-subhead">{SETTINGS_STRINGS.accessPolicyHeading}</h3>
      <dl className="settings-detail-list">
        <dt>{SETTINGS_STRINGS.accessPolicySignupLabel}</dt>
        <dd>
          <Badge tone={config.signupMode === "closed" ? "neutral" : "info"}>
            {signupLabel}
          </Badge>
          <span className="settings-member-email">
            {" "}
            {SETTINGS_STRINGS.accessPolicySignupEnvNote}
          </span>
        </dd>
        <dt>{SETTINGS_STRINGS.accessPolicyDomainsLabel}</dt>
        <dd>
          {config.allowedEmailDomains.length === 0 ? (
            <span className="settings-member-email">
              {config.signupMode === "open"
                ? SETTINGS_STRINGS.accessPolicyDomainsAny
                : SETTINGS_STRINGS.accessPolicyDomainsNone}
            </span>
          ) : (
            <div className="settings-chip-row">
              {config.allowedEmailDomains.map((domain) => (
                <span key={domain} className="settings-chip">
                  {domain}
                </span>
              ))}
            </div>
          )}
        </dd>
      </dl>
      <p className="settings-field-hint">{SETTINGS_STRINGS.accessPolicyNote}</p>
    </div>
  );
}
