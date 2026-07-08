import { Link, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { toHumanLabel } from "@workbench/ui";
import { useToolDetail } from "../hooks/use-tools";
import { getMe } from "../lib/hub-api";
import { ApiError } from "../lib/api";

export function SettingsToolDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60_000,
  });
  const tenantId = meQuery.data?.personalTenantId ?? null;
  const toolQuery = useToolDetail(id ?? null, tenantId);

  const notFound =
    toolQuery.error instanceof ApiError && toolQuery.error.status === 404;
  // Gamma presentation templates moved to the Owner area (CL-2884); this page
  // no longer manages them, but points owners to where they now live.
  const isGamma = toolQuery.data?.providerName === "gamma";

  return (
    <div className="flex h-full overflow-hidden bg-bg">
      <section className="flex min-h-full flex-1 flex-col overflow-y-auto border border-border bg-bg shadow-[var(--shadow,0_2px_6px_rgba(0,0,0,0.3))]">
        <div className="px-4 pt-5 sm:px-7">
          <button
            type="button"
            onClick={() => navigate("/settings")}
            className="flex items-center gap-1.5 text-[12.5px] text-text-3 transition-[color] hover:text-text"
          >
            <ArrowLeft size={14} />
            Settings
          </button>
        </div>

        <div className="flex-1 px-4 pb-10 pt-4 sm:px-7">
          {(toolQuery.isLoading || meQuery.isLoading) && (
            <div className="py-10 text-[13px] text-text-3">Loading tool…</div>
          )}
          {toolQuery.isError && (
            <div className="py-10 text-[13px] text-red-500">
              {notFound
                ? "This tool isn't available for your workbench."
                : "Could not load this tool."}
            </div>
          )}
          {!toolQuery.isLoading &&
            !meQuery.isLoading &&
            !toolQuery.isError &&
            toolQuery.data && (
              <div className="max-w-3xl">
                <div className="flex items-center gap-2">
                  <span className="inline-block rounded-full bg-surface-2 px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.03em] text-text-2">
                    {toolQuery.data.providerName}
                  </span>
                </div>
                <h1 className="mt-2.5 text-[22px] font-bold tracking-[-0.01em] text-text">
                  {toHumanLabel(toolQuery.data.name)}
                </h1>
                <p className="mt-1 font-mono text-[12px] text-text-3">
                  {toolQuery.data.name}
                </p>
                <p className="mt-2 text-pretty text-[13.5px] leading-relaxed text-text-2">
                  {toolQuery.data.description || "No description provided."}
                </p>

                <div className="mt-7">
                  {isGamma ? (
                    <p className="text-[13px] text-text-3">
                      Gamma presentation templates are managed in the{" "}
                      <Link
                        to="/owner"
                        className="text-text underline underline-offset-2"
                      >
                        Owner area
                      </Link>
                      .
                    </p>
                  ) : (
                    <p className="text-[13px] text-text-3">
                      No additional settings for this tool.
                    </p>
                  )}
                </div>
              </div>
            )}
        </div>
      </section>
    </div>
  );
}
