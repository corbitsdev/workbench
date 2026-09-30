// Name/email readout is read-only: no native profile-update route exists.
// The Agent card was removed — nothing there could change until a hub
// preference store exists to write it to.

import { Badge, Button } from "@corbits/react-ui";
import { toast } from "@corbits/react-ui/ui/toast";
import { ChatCircleDots, Copy, SignOut } from "@/lib/icons";
import { useQuery } from "@tanstack/react-query";

import { QueryView, toAPIQuery } from "@/lib/api-query";
import { resolveAvatarFill } from "@/chat";
import { IdentityAvatar } from "@/chat/avatar";
import webPackage from "../../package.json";
import { getAccount, type Account } from "./api";
import { Segmented, SettingsGroup, SettingsRow } from "./rows";
import { SETTINGS_STRINGS } from "./strings";
import { isTheme, setTheme, useTheme } from "../theme-store";

/** The repo's own issue tracker — read off this package's manifest (set
 * from `git remote`) rather than a hardcoded org/repo guess. */
const FEEDBACK_URL = `${webPackage.repository.url}/issues`;

export function AccountSection({ onSignOut }: { readonly onSignOut?: () => void }) {
  const query = toAPIQuery<Account>(useQuery({ queryKey: ["me", "account"], queryFn: getAccount }));

  return (
    <>
      <QueryView query={query} label={SETTINGS_STRINGS.accountLoadError}>
        {(account) => (
          <AccountSectionView
            id={account.id}
            name={account.name}
            email={account.email}
            emailVerified={account.emailVerified}
            {...(account.image !== null && account.image !== undefined
              ? { image: account.image }
              : {})}
            {...(onSignOut !== undefined ? { onSignOut } : {})}
          />
        )}
      </QueryView>
      <AppearanceSection />
    </>
  );
}

async function copyEmail(email: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(email);
    toast(SETTINGS_STRINGS.accountEmailCopiedToast);
  } catch {
    toast(SETTINGS_STRINGS.accountEmailCopyError);
  }
}

// Kept separate from `AccountSection`, like `BenchSectionView`, so it's
// directly renderable in tests without a fetch stub.
export function AccountSectionView({
  id,
  name,
  email,
  emailVerified,
  image,
  onSignOut,
}: {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly image?: string;
  readonly onSignOut?: () => void;
}) {
  const fill = resolveAvatarFill(id, image);
  return (
    <SettingsGroup title={SETTINGS_STRINGS.accountSectionTitle}>
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            {fill.kind === "image" ? (
              <img
                className="settings-account-avatar-image"
                src={fill.url}
                alt={name}
                width={40}
                height={40}
              />
            ) : (
              <IdentityAvatar kind="person" name={name} principalId={id} />
            )}
            {name}
          </span>
        }
        meta={
          <>
            {email}
            <Badge tone={emailVerified ? "success" : "neutral"}>
              {emailVerified ? "verified" : "unverified"}
            </Badge>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={SETTINGS_STRINGS.accountCopyEmailAction}
              title={SETTINGS_STRINGS.accountCopyEmailAction}
              onClick={() => void copyEmail(email)}
            >
              <Copy />
            </Button>
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <a href={FEEDBACK_URL} target="_blank" rel="noreferrer">
                <ChatCircleDots /> Send Feedback
              </a>
            </Button>
            {onSignOut !== undefined ? (
              <Button variant="outline" size="sm" onClick={onSignOut}>
                <SignOut /> {SETTINGS_STRINGS.accountSignOutAction}
              </Button>
            ) : null}
          </>
        }
      />
      <p className="settings-field-hint">{SETTINGS_STRINGS.accountReadOnlyNote}</p>
    </SettingsGroup>
  );
}

/** Theme row, wired to the theme store, which applies and persists the choice. */
export function AppearanceSection() {
  const theme = useTheme();
  return (
    <SettingsGroup title={SETTINGS_STRINGS.appearanceSectionTitle}>
      <SettingsRow
        title={SETTINGS_STRINGS.appearanceThemeLabel}
        actions={
          <Segmented
            label={SETTINGS_STRINGS.appearanceThemeLabel}
            value={theme}
            options={[
              { value: "light", label: SETTINGS_STRINGS.themeLight },
              { value: "dark", label: SETTINGS_STRINGS.themeDark },
              { value: "canvas", label: SETTINGS_STRINGS.themeCanvas },
            ]}
            onChange={(next) => {
              if (isTheme(next)) setTheme(next);
            }}
          />
        }
      />
    </SettingsGroup>
  );
}
