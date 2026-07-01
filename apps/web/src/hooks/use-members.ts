import { useQuery } from "@tanstack/react-query";
import { type } from "arktype";
import { api } from "../lib/api";

// A tenant member as returned by `GET /members`: `id` is the user's principal
// id (the value the delegate endpoint expects), `name` is the human label.
export const MemberSchema = type({ id: "string", name: "string" });
export type Member = typeof MemberSchema.infer;

const MembersResponseSchema = type({ members: MemberSchema.array() });

export function useMembers(
  tenantId?: string | null,
  options?: { enabled?: boolean },
) {
  return useQuery<Member[]>({
    queryKey: ["members", tenantId ?? null],
    queryFn: async () => {
      const raw = await api<unknown>(
        "GET",
        `/members?tenantId=${encodeURIComponent(tenantId ?? "")}`,
      );
      const parsed = MembersResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected members response: ${parsed.summary}`);
      }
      return parsed.members;
    },
    enabled:
      tenantId !== null && tenantId !== undefined && (options?.enabled ?? true),
    staleTime: 5 * 60_000,
  });
}
