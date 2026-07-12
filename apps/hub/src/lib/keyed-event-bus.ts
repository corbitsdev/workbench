export type KeyedEventBus<E> = {
  publish(key: string, event: E): void;
  subscribe(key: string, listener: (event: E) => void): () => void;
};

// In-process pub/sub keyed by an arbitrary string key. A key may hold several
// listeners (e.g. multiple open tabs/devices for one principal), so the value
// is a Set rather than a single slot — every listener under a key receives
// every publish, and unsubscribing one never affects the others. A key with
// no listeners is dropped from the map so publish-to-none is an early
// no-op-and-cleanup. Single-hub-replica scope: publisher and subscriber must
// live in the same process.
export function createKeyedEventBus<E>(): KeyedEventBus<E> {
  const listenersByKey = new Map<string, Set<(event: E) => void>>();

  return {
    publish(key, event) {
      const listeners = listenersByKey.get(key);
      if (listeners === undefined) return;
      for (const listener of listeners) listener(event);
    },
    subscribe(key, listener) {
      let listeners = listenersByKey.get(key);
      if (listeners === undefined) {
        listeners = new Set();
        listenersByKey.set(key, listeners);
      }
      listeners.add(listener);
      return () => {
        const current = listenersByKey.get(key);
        if (current === undefined) return;
        current.delete(listener);
        if (current.size === 0) listenersByKey.delete(key);
      };
    },
  };
}
