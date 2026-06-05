import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router';
import {
  listPrincipalGrants,
  getPrincipal,
  type GrantDetail,
  type PrincipalDetail,
} from '../lib/hub-api';

type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T };

export default function PrincipalSettingsPage() {
  const { tenantId, principalId } = useParams<{ tenantId: string; principalId: string }>();

  const [principal, setPrincipal] = useState<LoadState<PrincipalDetail>>({ status: 'loading' });
  const [grants, setGrants] = useState<LoadState<GrantDetail[]>>({ status: 'loading' });

  useEffect(() => {
    if (!tenantId || !principalId) return;

    getPrincipal(tenantId, principalId)
      .then((data) => setPrincipal({ status: 'ready', data }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to load principal';
        setPrincipal({ status: 'error', message });
      });

    listPrincipalGrants(tenantId, principalId)
      .then((data) => setGrants({ status: 'ready', data }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Failed to load grants';
        setGrants({ status: 'error', message });
      });
  }, [tenantId, principalId]);

  const displayName =
    principal.status === 'ready' ? principal.data.displayName : (principalId ?? '');

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <div className="mb-6">
          {tenantId !== undefined && (
            <Link
              to={`/settings/tenants/${tenantId}`}
              className="mb-2 block text-[12px] text-text-3 hover:text-text"
            >
              Back to tenant settings
            </Link>
          )}
          <h1 className="text-[18px] font-semibold text-text">{displayName}</h1>
          <p className="mt-1 text-[13px] text-text-3">Principal settings</p>
          {principal.status === 'ready' && (
            <div className="mt-2 flex gap-4 text-[12px] text-text-3">
              <span>Kind: {principal.data.kind}</span>
              <span>Status: {principal.data.status}</span>
              {principal.data.roles.length > 0 && (
                <span>Roles: {principal.data.roles.map((r) => r.name).join(', ')}</span>
              )}
            </div>
          )}
          {principal.status === 'error' && principal.message && (
            <p className="mt-2 text-[13px] text-red-500">{principal.message}</p>
          )}
        </div>

        <section>
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-text-3">
            Grants
          </h2>
          {grants.status === 'loading' && <p className="text-[13px] text-text-3">Loading…</p>}
          {grants.status === 'error' && grants.message && (
            <p className="text-[13px] text-red-500">{grants.message}</p>
          )}
          {grants.status === 'ready' && grants.data.length === 0 && (
            <p className="text-[13px] text-text-3">No grants assigned to this principal.</p>
          )}
          {grants.status === 'ready' && grants.data.length > 0 && (
            <div className="overflow-hidden rounded-[10px] border border-border">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-surface">
                    <th className="px-4 py-2 text-left font-medium text-text-3">Resource</th>
                    <th className="px-4 py-2 text-left font-medium text-text-3">Action</th>
                    <th className="px-4 py-2 text-left font-medium text-text-3">Effect</th>
                    <th className="px-4 py-2 text-left font-medium text-text-3">Origin</th>
                  </tr>
                </thead>
                <tbody>
                  {grants.data.map((g) => (
                    <tr key={g.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2 font-mono text-[12px] text-text">{g.resource}</td>
                      <td className="px-4 py-2 text-text-2">{g.action}</td>
                      <td className="px-4 py-2 capitalize text-text-2">{g.effect}</td>
                      <td className="px-4 py-2 capitalize text-text-2">{g.origin}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
