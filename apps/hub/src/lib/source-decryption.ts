import { decryptSecret } from '@workbench/hub-crypto';
import { getConfig } from '../config';

export function decryptSources<T extends { apiKey?: string }>(sources: T[], tenantId: string): T[] {
  const keys = getConfig().credentialKeys;
  return sources.map((source) => {
    if (!source.apiKey?.startsWith('enc:')) return source;
    return { ...source, apiKey: decryptSecret(keys, tenantId, source.apiKey) };
  });
}
