// The "Account" settings section: name and email as the hub's authentication
// API knows them. Read-only — there is no native profile-update route (see
// `vendor/intx/hub-api/src/routes` — only tenants and principals carry a
// PATCH); this section renders whatever `GET /api/me` returns and says so.

import { Badge, Button, SettingsPanel } from "@corbits/react-ui";
import { LogOut } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  QueryView,
  UnauthenticatedError,
  describeQueryError,
} from "@corbits/api-query";
import { getAccount, type Account } from "./api";
import { SETTINGS_STRINGS } from "./strings";

export function AccountSection({
  onSignOut,
}: {
  readonly onSignOut?: () => void;
}) {
  const [query, setQuery] = useState<APIQuery<Account>>({ kind: "loading" });

  const load = useCallback(() => {
    setQuery({ kind: "loading" });
    let cancelled = false;
    getAccount()
      .then((account) => {
        if (!cancelled) setQuery({ kind: "ready", data: account });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof UnauthenticatedError) {
          setQuery({ kind: "unauthenticated" });
          return;
        }
        setQuery({
          kind: "error",
          message: describeQueryError(cause),
          retry: load,
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  return (
    <QueryView query={query} label={SETTINGS_STRINGS.accountLoadError}>
      {(account) => (
        <AccountSectionView
          name={account.name}
          email={account.email}
          emailVerified={account.emailVerified}
          {...(onSignOut !== undefined ? { onSignOut } : {})}
        />
      )}
    </QueryView>
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
