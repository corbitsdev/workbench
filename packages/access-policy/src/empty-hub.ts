// The closed-signup empty-hub exception (CL-7578, CL-8085): with zero
// users and zero tenants, someone has to be first — the signup that
// opens a brand-new hub is allowed even when signup is closed. A native
// read over `user`/`tenant` only; this package declares no tables of its
// own for it.
import { count } from "drizzle-orm";
import type { DB } from "@intx/db";
import { tenant, user as userTable } from "@intx/db/schema";

export type EmptyHubCheck = {
  countUsers(): Promise<number>;
  countTenants(): Promise<number>;
};

export function createEmptyHubCheck(db: DB["db"]): EmptyHubCheck {
  return {
    async countUsers() {
      const [row] = await db.select({ n: count() }).from(userTable);
      return row?.n ?? 0;
    },
    async countTenants() {
      const [row] = await db.select({ n: count() }).from(tenant);
      return row?.n ?? 0;
    },
  };
}
