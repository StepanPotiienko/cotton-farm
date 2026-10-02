import type { EventBus, GameEvents } from '../core/Events';
import { useGameStore } from '../state/store';
import config from '../state/config/game.json';
import { getTrapConfig } from '../entities/Trap';

export class ShopSystem {
  constructor(private readonly events: EventBus<GameEvents>) {}

  buyLand(landId: string): boolean {
    if (!useGameStore.getState().buyLand(landId)) return false;
    this.events.emit('shop:purchased', { itemId: landId, cost: config.cottonAttack.landCost });
    return true;
  }

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
