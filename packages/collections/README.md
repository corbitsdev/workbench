# @corbits/collections

Bounded, self-evicting in-memory collections for state that would
otherwise grow for the lifetime of the process that holds it (CL-7233).

## `createExpiringMap`

A `Map`-like store where every entry carries a TTL from the moment it is
set. `get` drops an expired entry lazily on read; `set` opportunistically
sweeps every expired entry once per TTL window, so memory tracks recent
activity rather than the lifetime count of distinct keys ever seen —
without a timer to leak or `unref`.

```ts
import { createExpiringMap } from "@corbits/collections";

const lastSeenByUser = createExpiringMap<string, number>({ ttlMs: 10_000 });
lastSeenByUser.set(userId, Date.now());
lastSeenByUser.get(userId); // undefined once ttlMs has elapsed
```

This is the first primitive in the package. `apps/hub/src/launch-caches.ts`'s
`BoundedCache` (size-capped LRU, no TTL) is a sibling that predates this
package — CL-7229 and CL-7223 are expected to either consume
`createExpiringMap` directly or contribute the size-capped-LRU shape here
so `BoundedCache` can retire in favor of one place for this problem.
