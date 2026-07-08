import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { adminTableCard } from "./admin-ui";
import { CredentialRow } from "./CredentialRow";
import { getOwnerCredentials } from "../../lib/hub-api";

// Integrations/tools the workbench exposes with a dedicated sub-page. Add a
// new integration by appending here and mounting its sub-route — no other
// wiring. Providers without a dedicated config page (Granola, Exa, Firecrawl,
// Linear, GitHub, Attio) are rendered inline below as credential rows instead
// (see `CREDENTIAL_PROVIDER_CATALOG`'s `kind: "tool"` entries).
const CAPABILITIES = [
  {
    id: "gamma",
    name: "Gamma",
    description: "Presentation templates for agent-generated decks.",
    to: "/owner/capabilities/gamma",
  },
] as const;

/**
 * Owner → Capabilities. The workbench's tools/integrations: Gamma configures
 * on its own sub-page; every other tool provider (CL-2879/CL-2883) is an
 * inline credential row here — configured/missing badge, write-only
 * "Set/Replace key", and Clear. Secrets are write-only end to end: the owner
 * pastes a key in and it is sent straight to the hub; every read only ever
 * sees masked configured/missing state, never the key itself.
 */
export function OwnerCapabilities() {
  const credentials = useQuery({
    queryKey: ["owner", "credentials"],
    queryFn: getOwnerCredentials,
  });
  const toolCredentials = credentials.data?.filter((c) => c.kind === "tool");

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-sm text-text-2">
          Tools and integrations available in this workbench. Select Gamma to
          configure its templates.
        </p>
        <div className={adminTableCard}>
          <ul className="divide-y divide-border">
            {CAPABILITIES.map((cap) => (
              <li key={cap.id}>
                <Link
                  to={cap.to}
                  className="flex items-center justify-between gap-4 p-4 transition-colors hover:bg-page"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">{cap.name}</p>
                    <p className="mt-0.5 text-xs text-text-2">
                      {cap.description}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm text-text-3">
                    Configure →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-text">
          Integration credentials
        </h2>
        <p className="mb-2 text-sm text-text-2">
          Set or clear API keys for the other tools this workbench uses. Keys
          are write-only — once saved, the key itself is never shown again, only
          whether a provider is configured.
        </p>
        {credentials.isLoading ? (
          <p className="p-3 text-sm text-text-2">Loading…</p>
        ) : credentials.isError || !toolCredentials ? (
          <p className="p-3 text-sm text-text-2">
            Could not load credentials. Try again in a moment.
          </p>
        ) : toolCredentials.length === 0 ? (
          <p className="p-3 text-sm text-text-2">
            No other tool integrations are configurable for this workbench yet.
          </p>
        ) : (
          <div className={adminTableCard}>
            <ul className="divide-y divide-border">
              {toolCredentials.map((c) => (
                <CredentialRow key={c.providerName} credential={c} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
