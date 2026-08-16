// The "Account" settings section: name and email as the hub's authentication
// API knows them. Read-only — there is no native profile-update route (see
// `vendor/intx/hub-api/src/routes` — only tenants and principals carry a
// PATCH); this section renders whatever `GET /api/me` returns and says so.

import {
  Badge,
  Button,
  EmptyState,
  SettingsPanel,
  Skeleton,
} from "@corbits/react-ui";
import { CircleAlert, LogOut } from "lucide-react";
import { useEffect, useState } from "react";

import { getAccount, type Account } from "./api";
import { errorMessage, type LoadState } from "./load-state";
import { SETTINGS_STRINGS } from "./strings";

export function AccountSection({
  onSignOut,
}: {
  readonly onSignOut?: () => void;
}) {
  const [state, setState] = useState<LoadState<Account>>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    getAccount()
      .then((account) => {
        if (!cancelled) setState({ kind: "ready", data: account });
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
        title={`Couldn't load ${SETTINGS_STRINGS.accountLoadError}`}
        description={state.message}
      />
    );
  }

  return (
    <AccountSectionView
      name={state.data.name}
      email={state.data.email}
      emailVerified={state.data.emailVerified}
      {...(onSignOut !== undefined ? { onSignOut } : {})}
    />
  );
}

/**
 * The account panel's markup on its own, taking already-resolved display
 * fields — kept separate from `AccountSection` for the same reason
 * `BenchSectionView` is: directly renderable in tests without a fetch stub.
 */
export function AccountSectionView({
  name,
  email,
  emailVerified,
  onSignOut,
}: {
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly onSignOut?: () => void;
}) {
  return (
    <SettingsPanel
      title={SETTINGS_STRINGS.accountSectionTitle}
      description={SETTINGS_STRINGS.accountReadOnlyNote}
    >
      <dl className="settings-detail-list">
        <dt>{SETTINGS_STRINGS.accountNameLabel}</dt>
        <dd>{name}</dd>
        <dt>{SETTINGS_STRINGS.accountEmailLabel}</dt>
        <dd>
          {email}{" "}
          <Badge tone={emailVerified ? "success" : "neutral"}>
            {emailVerified ? "verified" : "unverified"}
          </Badge>
        </dd>
      </dl>
      {onSignOut !== undefined ? (
        <Button variant="outline" onClick={onSignOut}>
          <LogOut /> {SETTINGS_STRINGS.accountSignOutAction}
        </Button>
      ) : null}
    </SettingsPanel>
  );
}
