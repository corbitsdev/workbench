import { Link } from "react-router";
import { adminTableCard } from "./admin-ui";

// Integrations/tools the workbench exposes. Each entry is a capability with its
// own owner sub-page (`/owner/capabilities/<id>`). Add a new integration by
// appending here and mounting its sub-route — no other wiring.
const CAPABILITIES = [
  {
    id: "gamma",
    name: "Gamma",
    description: "Presentation templates for agent-generated decks.",
    to: "/owner/capabilities/gamma",
  },
] as const;

/**
 * Owner → Capabilities. The workbench's tools/integrations, each configured on
 * its own sub-page. Extensible: future integrations are additional entries with
 * their own `/owner/capabilities/<id>` route.
 */
export function OwnerCapabilities() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-text-2">
        Tools and integrations available in this workbench. Select one to
        configure it.
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
  );
}
