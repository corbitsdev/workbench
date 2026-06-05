import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router';
import {
  getTenant,
  listTenantPrincipals,
  listTenantCredentials,
  getMyPrincipals,
  type TenantDetailResponse,
  type PrincipalDetail,
  type CredentialDetail,
} from '../lib/hub-api';

type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T };

export default function TenantSettingsPage() {
  const { tenantId } = useParams<{ tenantId: string }>();

  const [tenant, setTenant] = useState<LoadState<TenantDetailResponse>>({ status: 'loading' });
  const [principals, setPrincipals] = useState<LoadState<PrincipalDetail[]>>({ status: 'loading' });
  const [credentials, setCredentials] = useState<LoadState<CredentialDetail[]>>({
    status: 'loading',
  });
  const [myPrincipalId, setMyPrincipalId] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) return;

    getTenant(tenantId)
      .then((data) => setTenant({ status: 'ready', data }))
      .catch((err: unknown) =>
        setTenant({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load tenant',
        })
      );

    listTenantPrincipals(tenantId)
      .then((data) => setPrincipals({ status: 'ready', data }))
      .catch((err: unknown) =>
        setPrincipals({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load members',
        })
      );

    listTenantCredentials(tenantId)
      .then((data) => setCredentials({ status: 'ready', data }))
      .catch((err: unknown) =>
        setCredentials({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to load credentials',
        })
      );

    getMyPrincipals()
      .then((all) => {
        const match = all.find((p) => p.tenantId === tenantId);
        if (match) setMyPrincipalId(match.id);
      })
      .catch(() => {
        // Non-fatal — principal link is optional
      });
  }, [tenantId]);

  const tenantName = tenant.status === 'ready' ? tenant.data.name : (tenantId ?? '');

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <div className="mb-6">
          <h1 className="text-[18px] font-semibold text-text">{tenantName}</h1>
          <p className="mt-1 text-[13px] text-text-3">Tenant settings</p>
        </div>

        {myPrincipalId !== null && (
          <div className="mb-6">
            <Link
              to={`/settings/tenants/${tenantId}/principals/${myPrincipalId}`}
              className="text-[13px] text-orange hover:underline"
            >
              View my principal grants
            </Link>
          </div>
        )}

        <section className="mb-8">
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-text-3">
            Members
          </h2>
          {principals.status === 'loading' && <p className="text-[13px] text-text-3">Loading…</p>}
          {principals.status === 'error' && (
            <p className="text-[13px] text-red-500">{principals.message}</p>
          )}
          {principals.status === 'ready' && principals.data.length === 0 && (
            <p className="text-[13px] text-text-3">No members found.</p>
          )}
          {principals.status === 'ready' && principals.data.length > 0 && (
            <div className="overflow-hidden rounded-[10px] border border-border">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-surface">
                    <th className="px-4 py-2 text-left font-medium text-text-3">Name</th>
                    <th className="px-4 py-2 text-left font-medium text-text-3">Kind</th>
                    <th className="px-4 py-2 text-left font-medium text-text-3">Status</th>
                    <th className="px-4 py-2 text-left font-medium text-text-3">Roles</th>
                  </tr>
                </thead>
                <tbody>
                  {principals.data.map((p) => (
                    <tr key={p.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2 text-text">
                        <Link
                          to={`/settings/tenants/${tenantId}/principals/${p.id}`}
                          className="hover:text-orange hover:underline"
                        >
                          {p.displayName}
                        </Link>
                      </td>
                      <td className="px-4 py-2 capitalize text-text-2">{p.kind}</td>
                      <td className="px-4 py-2 capitalize text-text-2">{p.status}</td>
                      <td className="px-4 py-2 text-text-2">
                        {p.roles.map((r) => r.name).join(', ') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-text-3">
            Credentials
          </h2>
          {credentials.status === 'loading' && <p className="text-[13px] text-text-3">Loading…</p>}
          {credentials.status === 'error' && (
            <p className="text-[13px] text-red-500">{credentials.message}</p>
          )}
          {credentials.status === 'ready' && credentials.data.length === 0 && (
            <p className="text-[13px] text-text-3">No credentials configured.</p>
          )}
          {credentials.status === 'ready' && credentials.data.length > 0 && (
            <div className="overflow-hidden rounded-[10px] border border-border">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-surface">
                    <th className="px-4 py-2 text-left font-medium text-text-3">Name</th>
                    <th className="px-4 py-2 text-left font-medium text-text-3">Provider</th>
                    <th className="px-4 py-2 text-left font-medium text-text-3">Type</th>
                    <th className="px-4 py-2 text-left font-medium text-text-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {credentials.data.map((c) => (
                    <tr key={c.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2 text-text">{c.name}</td>
                      <td className="px-4 py-2 text-text-2">{c.providerId}</td>
                      <td className="px-4 py-2 text-text-2">{c.type}</td>
                      <td className="px-4 py-2 capitalize text-text-2">{c.status}</td>
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
