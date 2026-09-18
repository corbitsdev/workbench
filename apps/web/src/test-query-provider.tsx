// retry:false + gcTime:0 keep test failures loud and cache-free; matches
// main.tsx's ThemeProvider so shell chrome renders under the same contract.

import { ThemeProvider } from "@corbits/react-ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
      },
    },
  });
}

export function TestQueryProvider({
  children,
  client = createTestQueryClient(),
}: {
  readonly children: ReactNode;
  readonly client?: QueryClient;
}) {
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </ThemeProvider>
  );
}
