// Settings shows what the hub actually serves for this account today: the
// profile and the bench memberships. Both panels are read-only because no
// hub endpoint accepts an edit yet; when one does, the panel that gains a
// save action is the one whose data it edits.

import {
  Badge,
  EmptyState,
  PageShell,
  SettingsPanel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TopBar,
  TopBarTitle,
} from "@corbits/react-ui";

import { PrincipalsSchema, ProfileSchema, useAPIQuery } from "../api";
import type { APIQuery, PrincipalsPage, Profile } from "../api";
import { QueryView, SignedOutNotice } from "../query-view";

export function SettingsPage({
  profile,
  principals,
}: {
  readonly profile: APIQuery<Profile>;
  readonly principals: APIQuery<PrincipalsPage>;
}) {
  return (
    <>
      <TopBar>
        <TopBarTitle subtitle="Your account and bench memberships">
          Settings
        </TopBarTitle>
      </TopBar>
      <PageShell width="prose" className="page-fill">
        {profile.kind === "unauthenticated" ? (
          <SignedOutNotice />
        ) : (
          <>
            <SettingsPanel
              title="Account"
              description="How the hub identifies you. Managed through the authentication API; editing from this screen has not been built yet."
            >
              <QueryView query={profile} label="your account">
                {(data) => (
                  <dl className="detail-list">
                    <dt>Name</dt>
                    <dd>{data.name}</dd>
                    <dt>Email</dt>
                    <dd>
                      {data.email}{" "}
                      <Badge tone={data.emailVerified ? "success" : "neutral"}>
                        {data.emailVerified ? "verified" : "unverified"}
                      </Badge>
                    </dd>
                    <dt>Member since</dt>
                    <dd>{new Date(data.createdAt).toLocaleDateString()}</dd>
                  </dl>
                )}
              </QueryView>
            </SettingsPanel>
            <SettingsPanel
              title="Benches"
              description="Every bench this account belongs to, and your roles in each."
            >
              <QueryView query={principals} label="your benches">
                {(page) =>
                  page.data.length === 0 ? (
                    <EmptyState
                      title="No benches yet"
                      description="This account is not a member of any bench. Benches are created through the hub API (/api/tenants)."
                    />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Bench</TableHead>
                          <TableHead>Roles</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {page.data.map((principal) => (
                          <TableRow key={principal.principalId}>
                            <TableCell>{principal.tenantName}</TableCell>
                            <TableCell>
                              {principal.roles.length === 0
                                ? "none"
                                : principal.roles
                                    .map((role) => role.name)
                                    .join(", ")}
                            </TableCell>
                            <TableCell>
                              <Badge
                                tone={
                                  principal.status === "active"
                                    ? "success"
                                    : "neutral"
                                }
                              >
                                {principal.status}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )
                }
              </QueryView>
            </SettingsPanel>
          </>
        )}
      </PageShell>
    </>
  );
}

export function SettingsRoute() {
  const profile = useAPIQuery("/api/me", ProfileSchema);
  const principals = useAPIQuery("/api/me/principals", PrincipalsSchema);
  return <SettingsPage profile={profile} principals={principals} />;
}
