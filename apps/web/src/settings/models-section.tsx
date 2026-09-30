// No write path here; changing an offering's priority belongs to the
// catalog-management routes this section deliberately doesn't touch.

import { Badge, EmptyState } from "@corbits/react-ui";
import { useQuery } from "@tanstack/react-query";

import { QueryView, toAPIQuery } from "@/lib/api-query";
import { listProviders, type Provider } from "./credentials-api";
import { getResolvedCatalog, type ModelInfo } from "./inference";
import { SettingsGroup, SettingsRow } from "./rows";
import { inferenceProviders, providerLabel } from "./inference-providers";
import { SETTINGS_STRINGS } from "./strings";

type ModelsData = {
  readonly providers: readonly Provider[];
  readonly models: readonly ModelInfo[];
};

export function ModelsSection({ tenantId }: { readonly tenantId: string | null }) {
  const query = toAPIQuery<ModelsData>(
    useQuery({
      queryKey: ["tenant", tenantId ?? "none", "settings-models"] as const,
      queryFn: async (): Promise<ModelsData> => {
        if (tenantId === null) return { providers: [], models: [] };
        const [providers, models] = await Promise.all([
          listProviders(tenantId),
          getResolvedCatalog(tenantId),
        ]);
        return { providers, models };
      },
      enabled: tenantId !== null,
    }),
  );

  if (tenantId === null) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.benchNoneSelectedTitle}
        description={SETTINGS_STRINGS.benchNoneSelectedDescription}
      />
    );
  }

  return (
    <QueryView query={query} label={SETTINGS_STRINGS.modelsLoadError}>
      {({ providers, models }) => (
        <SettingsGroup
          title={SETTINGS_STRINGS.modelsSectionTitle}
          description={SETTINGS_STRINGS.modelsSectionDescription}
        >
          <h3 className="settings-subhead">{SETTINGS_STRINGS.modelsProvidersHeading}</h3>
          <ProvidersTable providers={inferenceProviders(providers)} />
          <h3 className="settings-subhead">{SETTINGS_STRINGS.modelsCatalogHeading}</h3>
          <ModelsTable models={models} />
        </SettingsGroup>
      )}
    </QueryView>
  );
}

function ProvidersTable({ providers }: { readonly providers: readonly Provider[] }) {
  if (providers.length === 0) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.modelsProvidersEmptyTitle}
        description={SETTINGS_STRINGS.modelsProvidersEmptyDescription}
      />
    );
  }
  return (
    <>
      {providers.map((provider) => (
        <SettingsRow key={provider.id} title={providerLabel(provider)} />
      ))}
    </>
  );
}

function ModelsTable({ models }: { readonly models: readonly ModelInfo[] }) {
  if (models.length === 0) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.modelsEmptyTitle}
        description={SETTINGS_STRINGS.modelsEmptyDescription}
      />
    );
  }
  return (
    <>
      {models.map((model) => (
        <SettingsRow
          key={model.id}
          title={model.displayName ?? model.canonicalName}
          meta={model.offerings.map((offering, index) => (
            <Badge key={offering.offeringId} tone={index === 0 ? "success" : "neutral"}>
              {offering.providerName}
              {index === 0 ? ` · ${SETTINGS_STRINGS.modelsDefaultBadge}` : ""}
            </Badge>
          ))}
        />
      ))}
    </>
  );
}
