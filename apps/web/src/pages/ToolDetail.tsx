import { useMemo } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useToolDetail } from "../hooks/use-tools";
import { getMe } from "../lib/hub-api";
import { ApiError } from "../lib/api";
import { AppPageChromeRow, Button, toHumanLabel } from "@workbench/ui";
import { useSetPageChrome } from "../lib/page-chrome";
import { ProviderLogo } from "../components/ProviderLogo";

type ParamRow = {
  name: string;
  type: string;
  description: string;
  required: boolean;
};

// A JSON schema whose top-level params can't be flattened to a simple list
// (composition keywords or a non-object root). For these we must NOT claim the
// tool takes no parameters — we point the reader at the schema instead.
function schemaIsComplex(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const obj = schema as Record<string, unknown>;
  if ("$ref" in obj || "allOf" in obj || "anyOf" in obj || "oneOf" in obj)
    return true;
  return typeof obj.type === "string" && obj.type !== "object";
}

// Defensively narrow a JSON-schema-shaped `unknown` into a flat param list for
// display. Anything that does not match degrades to an empty list rather than
// throwing — the page still renders the tool's name and description.
function paramsFromSchema(schema: unknown): ParamRow[] {
  if (typeof schema !== "object" || schema === null) return [];
  const obj = schema as Record<string, unknown>;
  const properties = obj.properties;
  if (typeof properties !== "object" || properties === null) return [];
  const required = Array.isArray(obj.required)
    ? obj.required.filter((r): r is string => typeof r === "string")
    : [];

  return Object.entries(properties as Record<string, unknown>).map(
    ([name, raw]) => {
      const prop =
        typeof raw === "object" && raw !== null
          ? (raw as Record<string, unknown>)
          : {};
      return {
        name,
        type: typeof prop.type === "string" ? prop.type : "any",
        description:
          typeof prop.description === "string" ? prop.description : "",
        required: required.includes(name),
      };
    },
  );
}

export function ToolDetail() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60_000,
  });
  const tenantId = meQuery.data?.personalTenantId ?? null;
  const toolQuery = useToolDetail(name ?? null, tenantId);

  const schema = toolQuery.data?.inputSchema;
  const params = useMemo(() => paramsFromSchema(schema), [schema]);
  const notFound =
    toolQuery.error instanceof ApiError && toolQuery.error.status === 404;
  const isGamma = toolQuery.data?.providerName === "gamma";
  const toolName = toolQuery.data?.name;

  const pageChrome = useMemo(
    () =>
      toolName ? (
        <AppPageChromeRow
          title={toHumanLabel(toolName)}
          titleSize="sm"
          subtitle={toolName}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => navigate("/tools")}
            className="gap-1.5"
          >
            <ArrowLeft size={14} aria-hidden />
            Tools
          </Button>
        </AppPageChromeRow>
      ) : null,
    [toolName, navigate],
  );
  useSetPageChrome(pageChrome);

  return (
    <div className="flex h-full overflow-hidden bg-bg">
      <section className="flex min-h-full flex-1 flex-col overflow-y-auto border border-border bg-bg shadow-[var(--shadow,0_2px_6px_rgba(0,0,0,0.3))]">
        <div className="flex-1 px-4 pb-10 pt-5 sm:px-7">
          {toolQuery.isLoading && (
            <div className="py-10 text-[13px] text-text-3">Loading tool…</div>
          )}
          {toolQuery.isError && (
            <div className="py-10 text-[13px] text-text-3">
              {notFound
                ? "This tool isn't available for your workbench."
                : "Could not load this tool."}
            </div>
          )}
          {!toolQuery.isLoading && !toolQuery.isError && toolQuery.data && (
            <div className="max-w-[760px]">
              <div className="flex items-center gap-2">
                <ProviderLogo
                  providerName={toolQuery.data.providerName}
                  size={18}
                  hideFallback
                />
                <span className="inline-block rounded-full bg-surface-2 px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.03em] text-text-2">
                  {toolQuery.data.providerName}
                </span>
                {toolQuery.data.version !== null && (
                  <span className="inline-block rounded-full bg-surface-2 px-2 py-[3px] font-mono text-[10px] text-text-3">
                    v{toolQuery.data.version}
                  </span>
                )}
              </div>
              <p className="mt-2.5 text-pretty text-[13.5px] leading-relaxed text-text-2">
                {toolQuery.data.description || "No description provided."}
              </p>

              {isGamma && (
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      `/settings/tools/${encodeURIComponent(toolQuery.data.name)}`,
                    )
                  }
                  className="mt-4 inline-flex items-center justify-center rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm font-medium text-text transition-[background-color] hover:bg-surface"
                >
                  Manage templates
                </button>
              )}

              <h2 className="mt-7 text-[13px] font-semibold uppercase tracking-wide text-text-3">
                Parameters
              </h2>
              {params.length === 0 ? (
                <div className="mt-3 text-[13px] text-text-3">
                  {schemaIsComplex(schema)
                    ? "This tool's parameters use a structured schema; see the tool definition."
                    : "This tool takes no parameters."}
                </div>
              ) : (
                <ul className="mt-3 flex flex-col gap-2.5">
                  {params.map((p) => (
                    <li
                      key={p.name}
                      className="rounded-lg border border-border bg-surface p-3"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[13px] font-semibold text-text">
                          {p.name}
                        </span>
                        <span className="font-mono text-[11px] text-text-3">
                          {p.type}
                        </span>
                        {p.required && (
                          <span className="rounded-[5px] bg-orange/10 px-1.5 py-[1px] text-[10px] font-semibold uppercase text-orange">
                            required
                          </span>
                        )}
                      </div>
                      {p.description && (
                        <p className="mt-1 text-[12.5px] leading-relaxed text-text-2">
                          {p.description}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
