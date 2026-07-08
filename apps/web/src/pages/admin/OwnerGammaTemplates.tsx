import { useActiveWorkbench } from "../../lib/active-workbench-context";
import { GammaTemplateManager } from "../../components/GammaTemplateManager";

/**
 * Owner → Templates. Gamma presentation templates are a workbench feature, so
 * they live in the owner area (moved from Settings, CL-2884). Scoped to the
 * active workbench; the template hooks send its tenant id on every request.
 */
export function OwnerGammaTemplates() {
  const { activeTenantId } = useActiveWorkbench();
  return (
    <div className="space-y-4">
      <p className="text-sm text-text-2">
        Gamma presentation templates available to agents in this workbench.
      </p>
      <GammaTemplateManager tenantId={activeTenantId} />
    </div>
  );
}
