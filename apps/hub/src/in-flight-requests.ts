import { Hono, type MiddlewareHandler } from "hono";

export type InFlightRequestTracker = {
  readonly middleware: MiddlewareHandler;
  readonly pending: number;
  whenIdle: () => Promise<void>;
};

/**
 * Counts Hono handlers that have not yet returned a Response. Streaming
 * bodies (SSE) and upgraded websockets stay open after that return, so they
 * do not keep `pending` above zero — those are lingering connections the
 * drain force-closes, not in-flight work.
 */
export function createInFlightRequestTracker(): InFlightRequestTracker {
  let pending = 0;
  const waiters = new Set<() => void>();

  const notifyIfIdle = () => {
    if (pending !== 0) return;
    for (const waiter of waiters) waiter();
    waiters.clear();
  };

  const middleware: MiddlewareHandler = async (_c, next) => {
    pending += 1;
    try {
      await next();
    } finally {
      pending -= 1;
      notifyIfIdle();
    }
  };

  return {
    middleware,
    get pending() {
      return pending;
    },
    whenIdle() {
      if (pending === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.add(resolve);
      });
    },
  };
}

export function withInFlightRequestTracking<E extends object>(
  app: Hono<E>,
  tracker: InFlightRequestTracker,
): Hono<E> {
  const outer = new Hono<E>();
  outer.use(tracker.middleware);
  outer.route("/", app);
  return outer;
}
