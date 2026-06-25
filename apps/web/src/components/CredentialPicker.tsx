import type { Principal } from "../lib/hub-api";

type CredentialPickerCredential = {
  id: string;
  tenantId: string;
  name: string;
};

export interface CredentialPickerProps {
  principals: Principal[];
  credentialsByTenant: Record<string, CredentialPickerCredential[]>;
  selectedIds: string[];
  onSelect: (credentialIds: string[]) => void;
  isLoading?: boolean;
}

function tenantName(principals: Principal[], tenantId: string): string {
  const match = principals.find((p) => p.tenantId === tenantId);
  return match?.tenantName ?? tenantId;
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

export function CredentialPicker({
  principals,
  credentialsByTenant,
  selectedIds,
  onSelect,
  isLoading = false,
}: CredentialPickerProps) {
  if (isLoading) {
    return (
      <p
        className="text-sm text-text-2"
        data-testid="credential-picker-loading"
      >
        Loading credentials...
      </p>
    );
  }

  const entries = Object.entries(credentialsByTenant);
  const allCredentials = entries.flatMap(([, creds]) => creds);

  if (allCredentials.length === 0) {
    return (
      <p className="text-sm text-text-2" data-testid="credential-picker-empty">
        No credentials available.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="credential-picker">
      {entries.flatMap(([tenantId, creds]) =>
        creds.map((cred) => {
          const label = `${cred.name} — ${tenantName(principals, tenantId)}`;
          const checked = selectedIds.includes(cred.id);
          return (
            <label
              key={cred.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-text hover:bg-[var(--row-hover)]"
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-orange"
                checked={checked}
                onChange={() => onSelect(toggleId(selectedIds, cred.id))}
                data-testid={`credential-checkbox-${cred.id}`}
              />
              <span>{label}</span>
            </label>
          );
        }),
      )}
    </div>
  );
}
