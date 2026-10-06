export interface GameEvents {
  'cotton:launched': { baseId: string; side: 'goblin' | 'orc' };
  'base:destroyed': { baseId: string; side: 'goblin' | 'orc' };
  'land:unlocked': { landId: string };

  'currency:changed': { amount: number };
  'goblin:state': { state: string };
  'goblin:grabbed': undefined;
  'goblin:tap': { reward: number };
  'trap:triggered': { trapId: string; reward: number };
  'shop:purchased': { itemId: string; cost: number };
  'combo:chain': { count: number; multiplier: number; reward: number };
  'item:moved': { itemId: string };
  'borshch:sold': { reward: number };
}
type Listener<T> = (payload: T) => void;
export class EventBus<Events extends object> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const bucket = this.listeners.get(event) ?? new Set<Listener<never>>();
    bucket.add(listener as Listener<never>);
    this.listeners.set(event, bucket);
    return () => bucket.delete(listener as Listener<never>);
  }
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.listeners.get(event)?.forEach((listener) => listener(payload as never));
  }
}
