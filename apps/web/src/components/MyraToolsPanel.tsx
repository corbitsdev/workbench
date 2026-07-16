import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@workbench/ui";
import {
  myraPreferencesKey,
  putMyraPreferences,
  useMyraPreferences,
} from "../lib/myra-variants";

const TOOLS_NOTE =
  "Tool choices apply the next time Myra starts — new threads, future inbox automation runs, and existing threads after they next wake.";

interface MyraToolsPanelProps {
  readonly tenantId: string | null;
}

export function MyraToolsPanel({ tenantId }: MyraToolsPanelProps) {
  const queryClient = useQueryClient();
  const prefsQuery = useMyraPreferences(tenantId);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const mutation = useMutation({
    mutationFn: (body: {
      disabledCatalogPackages: string[];
      disabledToolNames: string[];
    }) => {
      if (!tenantId) throw new Error("No tenant");
      return putMyraPreferences(tenantId, body);
    },
    onSuccess: (data) => {
      if (tenantId) {
        queryClient.setQueryData(myraPreferencesKey(tenantId), data);
      }
    },
  });

  if (!tenantId) return null;
  if (prefsQuery.isLoading) {
    return <p className="text-sm text-text-3">Loading tool settings…</p>;
  }
  if (prefsQuery.isError || !prefsQuery.data) {
    return (
      <p className="text-sm text-text-3">Could not load Myra tool settings.</p>
    );
  }

  const prefs = prefsQuery.data;
  const disabledPackages = new Set(prefs.disabledCatalogPackages);
  const disabledTools = new Set(prefs.disabledToolNames);

  const persist = (nextPackages: string[], nextTools: string[]) => {
    mutation.mutate({
      disabledCatalogPackages: nextPackages,
      disabledToolNames: nextTools,
    });
  };

  const togglePackage = (packageKey: string, enabled: boolean) => {
    const nextPackages = new Set(prefs.disabledCatalogPackages);
    const nextTools = new Set(prefs.disabledToolNames);
    if (enabled) {
      nextPackages.delete(packageKey);
      const entry = prefs.toolCatalog.find((e) => e.package === packageKey);
      for (const tool of entry?.tools ?? []) {
        nextTools.delete(tool.name);
      }
    } else {
      nextPackages.add(packageKey);
    }
    persist([...nextPackages], [...nextTools]);
  };

  const toggleTool = (
    packageKey: string,
    toolName: string,
    enabled: boolean,
  ) => {
    if (disabledPackages.has(packageKey)) return;
    const nextTools = new Set(prefs.disabledToolNames);
    if (enabled) nextTools.delete(toolName);
    else nextTools.add(toolName);
    persist(prefs.disabledCatalogPackages, [...nextTools]);
  };

  if (prefs.toolCatalog.length === 0) {
    return (
      <p className="text-sm text-text-3">
        No optional tool packages are available for your workspace.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-text-3">{TOOLS_NOTE}</p>
      <ul className="flex flex-col gap-3">
        {prefs.toolCatalog.map((entry) => {
          const packageEnabled = !disabledPackages.has(entry.package);
          const isOpen = expanded[entry.package] ?? false;
          return (
            <li
              key={entry.package}
              className="rounded-[10px] border border-border bg-page"
            >
              <div className="flex items-center gap-3 p-3">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  className="flex shrink-0 items-center text-text-3"
                  onClick={() =>
                    setExpanded((s) => ({
                      ...s,
                      [entry.package]: !isOpen,
                    }))
                  }
                >
                  {isOpen ? (
                    <ChevronDown className="size-4" />
                  ) : (
                    <ChevronRight className="size-4" />
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text">
                    {entry.package}
                  </p>
                  <p className="text-xs text-text-3">{entry.description}</p>
                </div>
                <label className="flex items-center gap-2 text-xs text-text-2">
                  <input
                    type="checkbox"
                    checked={packageEnabled}
                    disabled={mutation.isPending}
                    onChange={(e) =>
                      togglePackage(entry.package, e.target.checked)
                    }
                  />
                  Enabled
                </label>
              </div>
              {isOpen && (
                <ul className="border-t border-border px-3 pb-3 pt-2">
                  {entry.tools.map((tool) => {
                    const toolEnabled =
                      packageEnabled && !disabledTools.has(tool.name);
                    return (
                      <li
                        key={tool.name}
                        className={cn(
                          "flex items-start justify-between gap-3 py-2",
                          !packageEnabled && "opacity-50",
                        )}
                      >
                        <div className="min-w-0">
                          <p className="font-mono text-xs text-text">
                            {tool.name}
                          </p>
                          <p className="text-xs text-text-3">
                            {tool.description}
                          </p>
                        </div>
                        <label className="flex shrink-0 items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={toolEnabled}
                            disabled={!packageEnabled || mutation.isPending}
                            onChange={(e) =>
                              toggleTool(
                                entry.package,
                                tool.name,
                                e.target.checked,
                              )
                            }
                          />
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
