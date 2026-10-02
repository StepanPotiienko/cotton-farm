import { createStore } from '../core/storeBase';
import config from './config/game.json';

export type BaseSide = 'goblin' | 'orc';
export const MAX_ATTACKS_PER_SIDE = Math.min(10, config.cottonAttack.maxPerSide);
export function baseSide(id: string): BaseSide | null {
  const match = /^(goblin|orc)-(\d+)$/.exec(id);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > MAX_ATTACKS_PER_SIDE || String(Number(match[2])) !== match[2]) return null;
  return match[1] as BaseSide;
}
export interface AttackProgress {
  attacks: Record<BaseSide, number>;
  destroyedCounts: Record<BaseSide, number>;
  pendingBases: string[];
  destroyedBases: string[];
  eligibleLand: string[];
  purchasedLand: string[];
}
export function initialAttackProgress(): AttackProgress {
  return { attacks: { goblin: 0, orc: 0 }, destroyedCounts: { goblin: 0, orc: 0 }, pendingBases: [], destroyedBases: [], eligibleLand: [], purchasedLand: [] };
}
export interface GameState extends AttackProgress {
  currency: number;
  inventory: string[];
  placed: { itemId: string; position: [number, number, number] }[];
  ownedItems: string[];
  unlockedTraps: string[];
  settings: { locale: 'uk' | 'en'; sound: boolean };
  cookingProgress: number;
  cottonGrowth: number;
  restoreProgress(progress: AttackProgress): void;
  launchCotton(id: string): boolean;
  destroyBase(id: string): boolean;
  buyLand(id: string): boolean;
  earn(amount: number): void;
  cook(seconds: number): void;
  resetCooking(): void;
  growCotton(seconds: number): void;
  harvestCotton(): boolean;
  sellBorshch(): boolean;
  spend(amount: number): boolean;
  unlockTrap(id: string): void;
  ownItem(id: string): void;
  resetStore(): void;
}

export const useGameStore = createStore<GameState>((set, get) => ({
  ...initialAttackProgress(),
  currency: config.economy.startingCurrency,
  inventory: [],
  placed: [],
  ownedItems: [],
  unlockedTraps: [],
  cookingProgress: 0,
  cottonGrowth: 0,
  settings: { locale: 'uk', sound: true },
  earn: (amount) => {
    if (Number.isFinite(amount) && amount >= 0) set({ currency: get().currency + amount });
  },
  cook: (seconds) => {
    if (Number.isFinite(seconds) && seconds > 0 && get().cookingProgress < 1) {
      set({ cookingProgress: Math.min(1, get().cookingProgress + seconds / config.borshch.cookSeconds) });
    }
  },
  resetCooking: () => set({ cookingProgress: 0 }),
  growCotton: (seconds) => {
    if (Number.isFinite(seconds) && seconds > 0 && get().cottonGrowth < 1) {
      set({ cottonGrowth: Math.min(1, get().cottonGrowth + seconds / config.yard.field.growthSeconds) });
    }
  },
  restoreProgress: (progress) => set({
    attacks: { ...progress.attacks }, destroyedCounts: { ...progress.destroyedCounts },
    pendingBases: [...progress.pendingBases], destroyedBases: [...progress.destroyedBases],
    eligibleLand: [...progress.eligibleLand], purchasedLand: [...progress.purchasedLand],
  }),
  launchCotton: (id) => {
    const side = baseSide(id), state = get();
    if (!side || state.cottonGrowth < 1 || state.attacks[side] >= MAX_ATTACKS_PER_SIDE || state.pendingBases.includes(id) || state.destroyedBases.includes(id)) return false;
    const index = Number(id.split('-')[1]);
    if (index > 1 && !state.destroyedBases.includes(`${side}-${index - 1}`)) return false;
    set({ cottonGrowth: 0, attacks: { ...state.attacks, [side]: state.attacks[side] + 1 }, pendingBases: [...state.pendingBases, id] });
    return true;
  },
  destroyBase: (id) => {
    const side = baseSide(id), state = get();
    if (!side || !state.pendingBases.includes(id) || state.destroyedBases.includes(id) || state.destroyedCounts[side] >= MAX_ATTACKS_PER_SIDE) return false;
    set({ pendingBases: state.pendingBases.filter((base) => base !== id), destroyedBases: [...state.destroyedBases, id], eligibleLand: [...state.eligibleLand, id], destroyedCounts: { ...state.destroyedCounts, [side]: state.destroyedCounts[side] + 1 } });
    return true;
  },
  buyLand: (id) => {
    const state = get();
    if (!state.eligibleLand.includes(id) || state.purchasedLand.includes(id) || !state.spend(config.cottonAttack.landCost)) return false;
    set({ purchasedLand: [...get().purchasedLand, id] });
    return true;
  },
  harvestCotton: () => {
    if (get().cottonGrowth < 1) return false;
    set({ cottonGrowth: 0 });
    return true;
  },
  sellBorshch: () => {
    if (get().cookingProgress < 1) return false;
    set({ cookingProgress: 0, currency: get().currency + config.borshch.saleReward });
    return true;
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
    ...initialAttackProgress(),
  currency: config.economy.startingCurrency,
    inventory: [],
    placed: [],
    ownedItems: [],
    unlockedTraps: [],
    cookingProgress: 0,
    cottonGrowth: 0,
    settings: { locale: 'uk', sound: true },
  }),
}));
