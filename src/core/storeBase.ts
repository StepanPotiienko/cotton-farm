type Setter<S> = (patch: Partial<S>) => void;
export function createStore<S>(initializer: (set: Setter<S>, get: () => S) => S) {
  let state: S;
  const listeners = new Set<(next: S) => void>();
  const set: Setter<S> = (patch) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener(state)); };
  state = initializer(set, () => state);
  return {
    getState: () => state,
    subscribe: (listener: (next: S) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
