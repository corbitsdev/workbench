// Shared QueryClientProvider for component tests that touch useAPIQuery /
// BenchProvider. retry:false + gcTime:0 keep failures loud and cache-free.

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
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
