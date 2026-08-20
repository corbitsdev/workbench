// Compile-time guard, enforced by `tsc --noEmit`: src/api.ts states the
// paginated envelope structurally (Paginated<T>) instead of using the
// schema-inferred type directly. If either side drifts, the assignments
// below stop compiling.

import { PrincipalSummary, paginatedSchema } from "@intx/types";
import type { APIQuery } from "@corbits/api-query";
import type { PrincipalsPage, Principal } from "../src/api";

const _schema = paginatedSchema(PrincipalSummary);
type Inferred = typeof _schema.infer;

// The inferred type must not be any-like, or these guards prove nothing.
// @ts-expect-error the inferred paginated type is not any-like
const _notAny: { totallyWrong: number } = null as unknown as Inferred;

// The inferred envelope carries exactly the structural fields.
declare const inferred: Inferred;
const _data: Principal[] = inferred.data;
const _cursor: string | null = inferred.nextCursor;

// At the query seam, a schema-backed result satisfies the structural page
// type, and a drifted structural envelope is rejected.
declare const principalsQuery: APIQuery<Inferred>;
const _accepted: APIQuery<PrincipalsPage> = principalsQuery;
// @ts-expect-error a drifted envelope (nextCursor: number) must be rejected
const _rejected: APIQuery<{ data: Principal[]; nextCursor: number }> =
  principalsQuery;
