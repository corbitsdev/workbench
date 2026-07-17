import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
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
      <Link
        to="/settings/owner/capabilities"
        className="inline-flex items-center gap-1.5 text-[12.5px] text-text-3 transition-[color] hover:text-text"
      >
        <ArrowLeft size={14} />
        Capabilities
      </Link>
      <p className="text-sm text-text-2">
        Gamma presentation templates available to agents in this workbench.
      </p>
      <GammaTemplateManager tenantId={activeTenantId} />
    </div>
  );
}
