import { useGameStore, type GameState, type AttackProgress, initialAttackProgress, baseSide } from '../state/store';
import config from '../state/config/game.json';

export interface SaveData {
  version: 2;
  attackProgress?: AttackProgress;
  currency: number;
  inventory: string[];
  placed: GameState['placed'];
  ownedItems: string[];
  unlockedTraps: string[];
  settings: GameState['settings'];
  lastSeenAt: number;
}

export interface LegacySaveData {
  version: 1;
  currency: number;
  inventory: string[];
  placed: GameState['placed'];
  settings: GameState['settings'];
  lastSeenAt: number;
}

const KEY = 'bavovna.save';

export function defaultSave(): SaveData {
  return {
    version: 2,
    attackProgress: initialAttackProgress(),
    currency: config.economy.startingCurrency,
    inventory: [],
    placed: [],
    ownedItems: [],
    unlockedTraps: [],
    settings: { locale: 'uk', sound: true },
    lastSeenAt: Date.now(),
  };
}

export function validateSave(value: unknown): value is SaveData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<SaveData>;
  return (data.attackProgress === undefined || validateAttackProgress(data.attackProgress)) && data.version === 2 && Number.isFinite(data.currency) && (data.currency ?? -1) >= 0 &&
    Array.isArray(data.inventory) && data.inventory.every((item) => typeof item === 'string') &&
    Array.isArray(data.placed) && data.placed.every((entry) => !!entry && typeof entry.itemId === 'string' &&
      Array.isArray(entry.position) && entry.position.length === 3 && entry.position.every(Number.isFinite)) &&
    Array.isArray(data.ownedItems) && data.ownedItems.every((item) => typeof item === 'string') &&
    Array.isArray(data.unlockedTraps) && data.unlockedTraps.every((item) => typeof item === 'string') &&
    typeof data.settings === 'object' && data.settings !== null &&
    (data.settings.locale === 'uk' || data.settings.locale === 'en') && typeof data.settings.sound === 'boolean' &&
    Number.isFinite(data.lastSeenAt);
}

export function validateAttackProgress(value: unknown): value is AttackProgress {
  if (!value || typeof value !== 'object') return false;
  const p = value as AttackProgress;
  const lists = [p.pendingBases, p.destroyedBases, p.eligibleLand, p.purchasedLand];
  if (!lists.every((list) => Array.isArray(list) && list.every((id) => typeof id === 'string' && baseSide(id) !== null) && new Set(list).size === list.length)) return false;
  if (!p.attacks || !p.destroyedCounts || p.pendingBases.some((id) => p.destroyedBases.includes(id))) return false;
  for (const side of ['goblin', 'orc'] as const) {
    const destroyed = p.destroyedBases.filter((id) => baseSide(id) === side);
    const pending = p.pendingBases.filter((id) => baseSide(id) === side);
    if (p.attacks[side] !== destroyed.length + pending.length || p.attacks[side] > 10 || p.destroyedCounts[side] !== destroyed.length) return false;
    if ([...destroyed, ...pending].some((id) => Number(id.split('-')[1]) > 1 && !destroyed.includes(`${side}-${Number(id.split('-')[1]) - 1}`))) return false;
  }
  return p.eligibleLand.length === p.destroyedBases.length && p.eligibleLand.every((id) => p.destroyedBases.includes(id)) && p.purchasedLand.every((id) => p.eligibleLand.includes(id));
}

/** Apply only validated persistent data; old version-2 saves receive empty progression. */
export function restoreGame(data: SaveData): boolean {
  if (!validateSave(data)) return false;
  const state = useGameStore.getState();
  state.resetStore();
  state.restoreProgress(data.attackProgress ?? initialAttackProgress());
  state.earn(Math.max(0, data.currency - useGameStore.getState().currency));
  for (const id of data.unlockedTraps) state.unlockTrap(id);
  for (const id of data.ownedItems) state.ownItem(id);
  return true;
}

export function migrateLegacySave(data: LegacySaveData): SaveData {
  return {
    version: 2,
    attackProgress: initialAttackProgress(),
    currency: data.currency,
    inventory: [...data.inventory],
    placed: [...data.placed],
    ownedItems: [],
    unlockedTraps: [],
    settings: { ...data.settings },
    lastSeenAt: data.lastSeenAt,
  };
}

export function saveGame(storage: Pick<Storage, 'setItem'> = localStorage): SaveData {
  const state = useGameStore.getState();
  const data: SaveData = {
    version: 2,
    attackProgress: {
      attacks: { ...state.attacks }, destroyedCounts: { ...state.destroyedCounts },
      pendingBases: [...state.pendingBases], destroyedBases: [...state.destroyedBases],
      eligibleLand: [...state.eligibleLand], purchasedLand: [...state.purchasedLand],
    },
    currency: state.currency,
    inventory: [...state.inventory],
    placed: [...state.placed],
    ownedItems: [...state.ownedItems],
    unlockedTraps: [...state.unlockedTraps],
    settings: { ...state.settings },
    lastSeenAt: Date.now(),
  };
  storage.setItem(KEY, JSON.stringify(data));
  return data;
}

export function loadGame(storage: Pick<Storage, 'getItem'> = localStorage): SaveData {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return defaultSave();
    const parsed: unknown = JSON.parse(raw);
    if (validateSave(parsed)) return parsed;
    // Migration path for version 1 saves.
    if (parsed && typeof parsed === 'object' && (parsed as Partial<LegacySaveData>).version === 1) {
      const legacy = parsed as LegacySaveData;
      const migrated = migrateLegacySave(legacy);
      return validateSave(migrated) ? migrated : defaultSave();
    }
    return defaultSave();
  } catch { return defaultSave(); }
}
