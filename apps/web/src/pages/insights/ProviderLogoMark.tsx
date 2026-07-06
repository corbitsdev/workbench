import { useState } from "react";
import { providerLogoUrl } from "../../lib/hub-api";

/**
 * A models.dev provider mark (CL-2714), sourced from the same-origin hub proxy
 * (`providerLogoUrl`), CSP-safe as a plain `<img>`. Falls back to a neutral
 * monogram when the logo 404s or the provider has no published mark — never a
 * broken image icon.
 */
export function ProviderLogoMark({
  tenantId,
  provider,
  providerName,
  size = 16,
}: {
  tenantId: string;
  provider: string;
  providerName: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-[4px] bg-surface-2 text-[10px] font-semibold uppercase text-text-3"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        {providerName.charAt(0)}
      </span>
    );
  }

  return (
    <img
      src={providerLogoUrl(tenantId, provider)}
      alt={providerName}
      width={size}
      height={size}
      loading="lazy"
      className="shrink-0 rounded-[4px] object-contain"
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}
