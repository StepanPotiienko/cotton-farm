import { useGameStore, type GameState } from '../state/store';
import config from '../state/config/game.json';

export interface SaveData {
  version: 2;
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
  return data.version === 2 && Number.isFinite(data.currency) && (data.currency ?? -1) >= 0 &&
    Array.isArray(data.inventory) && data.inventory.every((item) => typeof item === 'string') &&
    Array.isArray(data.placed) && data.placed.every((entry) => !!entry && typeof entry.itemId === 'string' &&
      Array.isArray(entry.position) && entry.position.length === 3 && entry.position.every(Number.isFinite)) &&
    Array.isArray(data.ownedItems) && data.ownedItems.every((item) => typeof item === 'string') &&
    Array.isArray(data.unlockedTraps) && data.unlockedTraps.every((item) => typeof item === 'string') &&
    typeof data.settings === 'object' && data.settings !== null &&
    (data.settings.locale === 'uk' || data.settings.locale === 'en') && typeof data.settings.sound === 'boolean' &&
    Number.isFinite(data.lastSeenAt);
}

export function migrateLegacySave(data: LegacySaveData): SaveData {
  return {
    version: 2,
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
      return migrated;
    }
    return defaultSave();
  } catch { return defaultSave(); }
}
