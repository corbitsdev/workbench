import { useQuery } from '@tanstack/react-query';
import { listWorkbenches } from '../lib/hub-api';
import type { WorkbenchEntry } from '../lib/hub-api';

export function useWorkbenches() {
  return useQuery<WorkbenchEntry[]>({
    queryKey: ['workbenches'],
    queryFn: () => listWorkbenches(),
    staleTime: 5 * 60_000,
  });
}
