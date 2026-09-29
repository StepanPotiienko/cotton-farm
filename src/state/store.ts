import { createStore } from '../core/storeBase';
import config from './config/game.json';

export interface GameState {
  currency: number;
  inventory: string[];
  placed: { itemId: string; position: [number, number, number] }[];
  ownedItems: string[];
  unlockedTraps: string[];
  settings: { locale: 'uk' | 'en'; sound: boolean };
  earn(amount: number): void;
  spend(amount: number): boolean;
  unlockTrap(id: string): void;
  ownItem(id: string): void;
  resetStore(): void;
}

export const useGameStore = createStore<GameState>((set, get) => ({
  currency: config.economy.startingCurrency,
  inventory: [],
  placed: [],
  ownedItems: [],
  unlockedTraps: [],
  settings: { locale: 'uk', sound: true },
  earn: (amount) => {
    if (Number.isFinite(amount) && amount >= 0) set({ currency: get().currency + amount });
  },
  spend: (amount) => {
    if (!Number.isFinite(amount) || amount <= 0 || get().currency < amount) return false;
    set({ currency: get().currency - amount });
    return true;
  },
  unlockTrap: (id) => {
    if (!get().unlockedTraps.includes(id)) set({ unlockedTraps: [...get().unlockedTraps, id] });
  },
  ownItem: (id) => {
    if (!get().ownedItems.includes(id)) set({ ownedItems: [...get().ownedItems, id] });
  },
  resetStore: () => set({
    currency: config.economy.startingCurrency,
    inventory: [],
    placed: [],
    ownedItems: [],
    unlockedTraps: [],
    settings: { locale: 'uk', sound: true },
  }),
}));
