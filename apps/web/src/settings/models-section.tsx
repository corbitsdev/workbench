// The "Models" settings section: a read-only view of this workbench's
// credential providers (`GET /api/tenants/:t/providers`, the same stock
// route `credentials-section.tsx` reads) and its resolved model catalog
// (`GET /api/tenants/:t/models`, `createModelDiscoveryRoutes` — the same
// read `resolveModelSources` would act on at launch). No write path here;
// changing an offering's priority or restricting it belongs to the
// catalog-management routes this section deliberately doesn't touch.

import {
  Badge,
  EmptyState,
  SettingsPanel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import { useQuery } from "@tanstack/react-query";

import { QueryView, toAPIQuery } from "@/lib/api-query";
import { listProviders, type Provider } from "./credentials-api";
import { getResolvedCatalog, type ModelInfo } from "./inference";
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
        <SettingsPanel
          title={SETTINGS_STRINGS.modelsSectionTitle}
          description={SETTINGS_STRINGS.modelsSectionDescription}
        >
          <h3 className="settings-subhead">{SETTINGS_STRINGS.modelsProvidersHeading}</h3>
          <ProvidersTable providers={providers} />
          <h3 className="settings-subhead">{SETTINGS_STRINGS.modelsCatalogHeading}</h3>
          <ModelsTable models={models} />
        </SettingsPanel>
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
    <div className="settings-table-scroll">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{SETTINGS_STRINGS.modelsProviderColumn}</TableHead>
            <TableHead>Plugin</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {providers.map((provider) => (
            <TableRow key={provider.id}>
              <TableCell>{provider.name}</TableCell>
              <TableCell>{provider.plugin}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
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
    <div className="settings-table-scroll">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{SETTINGS_STRINGS.modelsModelColumn}</TableHead>
            <TableHead>{SETTINGS_STRINGS.modelsOfferingsColumn}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {models.map((model) => (
            <TableRow key={model.id}>
              <TableCell>{model.displayName ?? model.canonicalName}</TableCell>
              <TableCell>
                {model.offerings.map((offering, index) => (
                  <Badge key={offering.offeringId} tone={index === 0 ? "success" : "neutral"}>
                    {offering.providerName}
                    {index === 0 ? ` · ${SETTINGS_STRINGS.modelsDefaultBadge}` : ""}
                  </Badge>
                ))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
