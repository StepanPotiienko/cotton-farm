import type { EventBus, GameEvents } from '../core/Events';
import { useGameStore } from '../state/store';
import { getTrapConfig } from '../entities/Trap';

export class ShopSystem {
  constructor(private readonly events: EventBus<GameEvents>) {}

  buyTrap(trapId: string): boolean {
    const trap = getTrapConfig(trapId);
    if (!trap) return false;
    const state = useGameStore.getState();
    if (state.unlockedTraps.includes(trapId)) return false;
    if (!state.spend(trap.cost)) return false;
    state.unlockTrap(trapId);
    this.events.emit('shop:purchased', { itemId: trapId, cost: trap.cost });
    return true;
  }
}
