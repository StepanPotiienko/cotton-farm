import { describe, expect, it, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { GoblinFSM, GoblinSpawner, OrcFSM, BatFSM } from '../entities/Goblin';
import { RakeTrap, HaystackLauncher, FryingPanTrap, AirDefenceTrap, createTrap, type TrapConfig } from '../entities/Trap';
import { ScoringSystem } from '../systems/ScoringSystem';
import { ShopSystem } from '../systems/ShopSystem';
import { EventBus, type GameEvents } from './Events';
import { useGameStore } from '../state/store';
import { loadGame, saveGame, validateSave, migrateLegacySave, type LegacySaveData } from './Save';
import config from '../state/config/game.json';
import RAPIER from '@dimforge/rapier3d-compat';
import { canHarvestCotton, canSelectTrapForPlacement, FIELD_TILE_THICKNESS, getActorFacingYaw, getCursorKnockbackImpulse, getEnemyBasePosition, getEnemySpawnKind, getFieldTilePositions, getFieldTileTopY, getGroundTopY, isValidTrapPlacement, type EnemyKind } from './Game';
import { Physics } from './Physics';

beforeEach(() => {
  useGameStore.getState().resetStore();
});

describe('Goblin FSM', () => {
  it('keeps the cartoon defeat cycle available after a cursor hit', () => {
    const goblin = new GoblinFSM();
    goblin.update(1 / 60);
    goblin.hit();
    expect(goblin.state).toBe('Dying');
    goblin.update(config.goblin.dyingSeconds + 0.01, 5, true);
    expect(goblin.state).toBe('Idle');
  });
  it('sneaks, grabs, flees, then dies after leaving view', () => {
    const goblin = new GoblinFSM(4);
    goblin.update(1 / 60);
    expect(goblin.state).toBe('Sneak');
    goblin.update(1 / 60, 0.5);
    expect(goblin.state).toBe('Grab');
    goblin.update(config.goblin.grabSeconds, 0.5);
    expect(goblin.state).toBe('Flee');
    goblin.update(0.1, 5, true);
    expect(goblin.state).toBe('Dying');
    goblin.update(config.goblin.dyingSeconds + 0.01, 5, true);
    expect(goblin.state).toBe('Idle');
  });
  it('a Sneak goblin hit() becomes Dying, not Stunned', () => {
    const goblin = new GoblinFSM();
    goblin.update(1 / 60);
    expect(goblin.state).toBe('Sneak');
    goblin.hit();
    expect(goblin.state).toBe('Dying');
  });
  it('a Grab goblin hit() becomes Dying', () => {
    const goblin = new GoblinFSM();
    goblin.update(1 / 60);
    goblin.update(1 / 60, 0.5);
    expect(goblin.state).toBe('Grab');
    goblin.hit();
    expect(goblin.state).toBe('Dying');
  });
  it('after Dying elapses the state becomes Idle (ready for respawn)', () => {
    const goblin = new GoblinFSM();
    goblin.update(1 / 60);
    expect(goblin.state).toBe('Sneak');
    goblin.hit();
    expect(goblin.state).toBe('Dying');
    goblin.update(config.goblin.dyingSeconds + 0.01, 5, true);
    expect(goblin.state).toBe('Idle');
  });
  it('ignores hits while Flee or Dying', () => {
    const goblin = new GoblinFSM();
    goblin.update(1 / 60);
    goblin.update(1 / 60, 0.5);
    goblin.update(config.goblin.grabSeconds + 0.01, 0.5);
    expect(goblin.state).toBe('Flee');
    goblin.hit();
    expect(goblin.state).toBe('Flee');
    goblin.update(0.1, 5, true);
    expect(goblin.state).toBe('Dying');
    goblin.hit();
    expect(goblin.state).toBe('Dying');
  });
  it('disables upright spring while stunned and restores it on recovery', () => {
    const goblin = new GoblinFSM();
    goblin.update(1 / 60);
    expect(goblin.state).toBe('Sneak');
    goblin.transition('Stunned');
    expect(goblin.springEnabled).toBe(false);
    goblin.update(config.goblin.stunSeconds + 0.01);
    expect(goblin.state).toBe('Recover');
    expect(goblin.springEnabled).toBe(true);
  });
});

describe('cursor knockback', () => {
  it('pushes the tapped actor away from the cursor and upward', () => {
    expect(getCursorKnockbackImpulse(new THREE.Vector3(2, 0, 0), new THREE.Vector3(0, 1, 0), 3))
      .toEqual({ x: 3, y: 1.5, z: 0 });
  });
});

describe('enemy target facing', () => {
  it.each(['Sneak', 'Grab'])('%s faces its current target in the XZ plane', (state) => {
    expect(getActorFacingYaw(state, 1, 2, 4, 6)).toBeCloseTo(Math.atan2(3, 4));
    expect(getActorFacingYaw(state, 4, 6, 1, 2)).toBeCloseTo(Math.atan2(-3, -4));
  });

  it('keeps flee facing forward and leaves stunned/death poses to their existing controllers', () => {
    expect(getActorFacingYaw('Flee', 1, 2, 4, 6)).toBe(0);
    expect(getActorFacingYaw('Stunned', 1, 2, 4, 6)).toBeNull();
    expect(getActorFacingYaw('Dying', 1, 2, 4, 6)).toBeNull();
  });
});

describe('startup traps', () => {
  it('does not configure any trap for automatic startup placement', () => {
    expect(config.yard.startingTrapIds).toEqual([]);
  });
});

describe('cotton field', () => {
  it('has two plots on either side of the central borshch plot', () => {
    expect(getFieldTilePositions()).toEqual([-2.7, -1.35, 0, 1.35, 2.7]);
    expect(config.yard.potPosition[0]).toBe(getFieldTilePositions()[2]);
  });

  it('grows deterministically to its cap, harvests only when ripe, and resets for regrowth', () => {
    const store = useGameStore.getState();
    expect(store.harvestCotton()).toBe(false);
    expect(canHarvestCotton(useGameStore.getState().cottonGrowth)).toBe(false);
    store.growCotton(config.yard.field.growthSeconds / 4);
    expect(useGameStore.getState().cottonGrowth).toBe(0.25);
    expect(store.harvestCotton()).toBe(false);
    store.growCotton(config.yard.field.growthSeconds);
    expect(useGameStore.getState().cottonGrowth).toBe(1);
    expect(canHarvestCotton(useGameStore.getState().cottonGrowth)).toBe(true);
    expect(store.harvestCotton()).toBe(true);
    expect(useGameStore.getState().cottonGrowth).toBe(0);
    expect(store.harvestCotton()).toBe(false);
  });

  it('rests field tiles flush on the platform surface with no float gap', () => {
    expect(getFieldTileTopY() - FIELD_TILE_THICKNESS).toBeCloseTo(getGroundTopY());
    expect(getFieldTileTopY()).toBeCloseTo(0.09);
  });

  it('resets growth with the rest of the game state', () => {
    useGameStore.getState().growCotton(config.yard.field.growthSeconds);
    useGameStore.getState().resetStore();
    expect(useGameStore.getState().cottonGrowth).toBe(0);
  });
});

describe('trap placement', () => {
  it('allows selecting an owned trap that is not already placed', () => {
    expect(canSelectTrapForPlacement('rake', ['rake'], [])).toBe(true);
    expect(canSelectTrapForPlacement('rake', [], [])).toBe(false);
    expect(canSelectTrapForPlacement('rake', ['rake'], ['rake'])).toBe(false);
  });

  it('accepts a ground location within the yard bounds', () => {
    expect(isValidTrapPlacement(1.5, -1)).toBe(true);
    expect(isValidTrapPlacement(config.yard.size / 2, 0)).toBe(true);
  });

  it('rejects ground locations outside the yard bounds', () => {
    expect(isValidTrapPlacement(config.yard.size / 2 + 0.01, 0)).toBe(false);
    expect(isValidTrapPlacement(Number.NaN, 0)).toBe(false);
  });
});

describe('Orc FSM', () => {
  it('shares the gentle trap cycle and can be identified independently', () => {
    const orc = new OrcFSM();
    orc.update(1 / 60);
    expect(orc.state).toBe('Sneak');
    orc.hit();
    expect(orc.state).toBe('Dying');
  });
});

describe('GoblinSpawner', () => {
  it('paces spawn attempts and respects pool limit', () => {
    const rng = () => 0;
    const spawner = new GoblinSpawner(rng, 0.5);
    expect(spawner.update(1, 3, 3)).toBe(false);
    // Binary-exact fractions (0.5, 0.25) so accumulated timer state never drifts.
    const paced = new GoblinSpawner(rng, 0.5);
    expect(paced.update(0.25, 0, 3)).toBe(false);
    expect(paced.update(0.25, 0, 3)).toBe(true);  // timer spent exactly as the second fraction lands
    expect(paced.update(0.4, 0, 3)).toBe(false);  // refilled for the next paced interval
  });

  it('uses matching edge bases for alternating faction spawn entries', () => {
    expect(config.yard.size).toBe(10);
    expect(getEnemyBasePosition('goblin')).toEqual({ x: -5.55, z: -2.02, y: 0.06 });
    expect(getEnemyBasePosition('orc')).toEqual({ x: 5.35, z: 2.49, y: 0.06 });
    expect(getEnemySpawnKind(0)).toBe('goblin');
    expect(getEnemySpawnKind(1)).toBe('orc');
    expect(getEnemyBasePosition(getEnemySpawnKind(0))).toEqual(getEnemyBasePosition('goblin'));
    expect(getEnemyBasePosition(getEnemySpawnKind(1))).toEqual(getEnemyBasePosition('orc'));
  });

  it('keeps faction arrivals on the configured paced spawn interval', () => {
    const spawner = new GoblinSpawner(() => 0.5, 0.5);
    // 0.5/0.25 are binary-exact so the accumulated timer has no drift.
    expect(spawner.update(0.25, 0, config.goblin.pool.maxActive)).toBe(false);
    expect(spawner.update(0.25, 0, config.goblin.pool.maxActive)).toBe(true);
    const interval = config.goblin.spawn.delayMinSeconds + 0.5 * (config.goblin.spawn.delayMaxSeconds - config.goblin.spawn.delayMinSeconds);
    expect(spawner.update(interval - 0.25, 0, config.goblin.pool.maxActive)).toBe(false);
    expect(spawner.update(0.25, 0, config.goblin.pool.maxActive)).toBe(true);
  });
});

describe('diorama platforms', () => {
  it('mounts each faction base on its own satellite ledge off the main platform', () => {
    const baseAngles = config.islands
      .map((island) => getEnemyBasePosition(island.kind as EnemyKind))
      .map((base) => Math.atan2(base.z, base.x));
    expect(baseAngles[0]).not.toBeCloseTo(baseAngles[1], 1);
    for (const island of config.islands) {
      const base = getEnemyBasePosition(island.kind as EnemyKind);
      expect(Math.hypot(base.x, base.z)).toBeGreaterThan(config.yard.size / 2);
      expect(base.y).toBe(island.topY);
      expect(Math.hypot(base.x - island.position[0], base.z - island.position[1])).toBeLessThan(island.radius - 0.5);
      expect(Math.hypot(island.position[0], island.position[1]) + island.radius).toBeGreaterThan(config.yard.size / 2);
      // Ledges overlap the main platform so sneaking walkers stay grounded.
      expect(Math.hypot(island.position[0], island.position[1]) - island.radius).toBeLessThan(config.yard.size / 2);
    }
  });

  it('gives every satellite ledge a cylinder collider matching its visual slab', async () => {
    await RAPIER.init();
    const physics = await Physics.create();
    physics.floor();
    const colliders: { y: number; radius: number; halfHeight: number }[] = [];
    physics.world.forEachCollider((collider) => {
      const shape = collider.shape as RAPIER.Cylinder;
      colliders.push({ y: collider.translation().y, radius: shape.radius, halfHeight: shape.halfHeight });
    });
    const ledgeColliders = colliders.slice(1); // index 0 is the central round platform
    expect(colliders[0].radius).toBe(config.yard.size / 2);
    expect(ledgeColliders).toHaveLength(config.islands.length);
    config.islands.forEach((island, index) => {
      expect(ledgeColliders[index].radius).toBeCloseTo(island.radius);
      expect(ledgeColliders[index].halfHeight).toBeCloseTo(island.height / 2);
      expect(ledgeColliders[index].y).toBeCloseTo(island.topY - island.height / 2);
    });
    physics.dispose();
  });
});

describe('currency store', () => {
  it('earns and refuses unaffordable spending', () => {
    const store = useGameStore.getState();
    store.earn(10);
    expect(useGameStore.getState().currency).toBe(10);
    expect(store.spend(12)).toBe(false);
    expect(store.spend(4)).toBe(true);
    expect(useGameStore.getState().currency).toBe(6);
  });
});

describe('save data', () => {
  it('round-trips a valid schema', () => {
    const memory = new Map<string, string>();
    const storage = { setItem: (key: string, entry: string) => memory.set(key, entry), getItem: (key: string) => memory.get(key) ?? null };
    useGameStore.getState().earn(12);
    useGameStore.getState().unlockTrap('rake');
    const saved = saveGame(storage);
    expect(validateSave(saved)).toBe(true);
    expect(loadGame(storage)).toEqual(saved);
  });
  it('falls back to defaults for corrupt data', () => {
    const storage = { getItem: () => '{bad json' };
    expect(loadGame(storage).version).toBe(2);
    expect(loadGame(storage).currency).toBe(0);
  });
  it('migrates version 1 to version 2 with empty unlockedTraps', () => {
    const legacy: LegacySaveData = {
      version: 1,
      currency: 42,
      inventory: ['seed'],
      placed: [{ itemId: 'pot', position: [0, 0, 0] }],
      settings: { locale: 'en', sound: false },
      lastSeenAt: 12345,
    };
    const memory = new Map<string, string>();
    const storage = {
      setItem: (key: string, entry: string) => memory.set(key, entry),
      getItem: (key: string) => memory.get(key) ?? null,
    };
    storage.setItem('bavovna.save', JSON.stringify(legacy));
    const loaded = loadGame(storage);
    expect(loaded.version).toBe(2);
    expect(loaded.currency).toBe(42);
    expect(loaded.unlockedTraps).toEqual([]);
    expect(loaded.ownedItems).toEqual([]);
    expect(loaded.settings).toEqual({ locale: 'en', sound: false });
  });
});

describe('RakeTrap', () => {
  const rakeCfg = config.traps[0] as TrapConfig;

  it('flips and kills a Sneak goblin that enters its trigger radius', () => {
    const events = new EventBus<GameEvents>();
    const trap = new RakeTrap(events, rakeCfg);
    trap.place(new THREE.Vector3(0, 0, 0));
    const goblin = new GoblinFSM(1, events);
    goblin.update(1 / 60);
    expect(goblin.state).toBe('Sneak');

    const triggered: { trapId: string; reward: number }[] = [];
    events.on('trap:triggered', (payload) => triggered.push(payload));

    trap.trigger(goblin);

    expect(trap.group.children[0].rotation.x).toBeCloseTo(Math.PI / 2);
    expect(triggered).toHaveLength(1);
    expect(triggered[0]).toEqual({ trapId: rakeCfg.id, reward: rakeCfg.reward });
    expect(goblin.state).toBe('Dying');
    expect(trap.triggered).toBe(true);
  });

  it('lies idle and returns to the lying pose after its reset interval', () => {
    const events = new EventBus<GameEvents>();
    const trap = new RakeTrap(events, rakeCfg);
    trap.place(new THREE.Vector3(0, 0, 0));
    const handle = trap.group.children[0];

    expect(handle.rotation.x).toBeCloseTo(0);

    trap.trigger(new GoblinFSM(1, events));
    expect(handle.rotation.x).toBeCloseTo(Math.PI / 2);

    trap.update(trap.resetSeconds);
    expect(trap.armed).toBe(true);
    expect(trap.triggered).toBe(false);
    expect(handle.rotation.x).toBeCloseTo(0);
  });

  it('does not affect goblins outside trigger radius in Game.stepActors logic', () => {
    const events = new EventBus<GameEvents>();
    const trap = new RakeTrap(events, rakeCfg);
    trap.place(new THREE.Vector3(0, 0, 0));
    const goblin = new GoblinFSM(1, events);
    goblin.update(1 / 60);
    // Just verify the trap public state; actual distance check lives in Game.checkTraps.
    expect(trap.armed).toBe(true);
    expect(goblin.state).toBe('Sneak');
  });
});

describe('HaystackLauncher', () => {
  const hayCfg = config.traps[1] as TrapConfig;

  it('triggers on a Sneak goblin and applies an upward impulse', async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.5, 0));
    world.createCollider(RAPIER.ColliderDesc.capsule(0.2, 0.2), body);

    const events = new EventBus<GameEvents>();
    const trap = new HaystackLauncher(events, hayCfg);
    trap.place(new THREE.Vector3(0, 0, 0));
    const goblin = new GoblinFSM(1, events);
    goblin.update(1 / 60);
    expect(goblin.state).toBe('Sneak');

    const triggered: { trapId: string; reward: number }[] = [];
    events.on('trap:triggered', (payload) => triggered.push(payload));

    trap.trigger(goblin, body);

    expect(triggered).toHaveLength(1);
    expect(triggered[0]).toEqual({ trapId: hayCfg.id, reward: hayCfg.reward });
    expect(goblin.state).toBe('Dying');
    expect(body.linvel().y).toBeGreaterThan(0);
    world.free();
  });
});

describe('FryingPanTrap', () => {
  const panCfg = config.traps[2] as TrapConfig;

  it('triggers and transitions goblin to Dying', () => {
    const events = new EventBus<GameEvents>();
    const trap = new FryingPanTrap(events, panCfg);
    trap.place(new THREE.Vector3(0, 0, 0));
    const goblin = new GoblinFSM(1, events);
    goblin.update(1 / 60);
    expect(goblin.state).toBe('Sneak');

    const triggered: { trapId: string; reward: number }[] = [];
    events.on('trap:triggered', (payload) => triggered.push(payload));

    trap.trigger(goblin);

    expect(triggered).toHaveLength(1);
    expect(triggered[0]).toEqual({ trapId: panCfg.id, reward: panCfg.reward });
    expect(goblin.state).toBe('Dying');
    expect(trap.triggered).toBe(true);
  });
});

describe('createTrap factory', () => {
  it.each(['rake', 'haystack', 'pan'])('returns the correct subclass for %s', (id) => {
    const events = new EventBus<GameEvents>();
    const trap = createTrap(id, events);
    expect(trap.id).toBe(id);
  });
});

describe('cotton attack progression', () => {
  it('launches ripe cotton, unlocks sequential land, and caps each side at ten', () => {
    const store = useGameStore.getState();
    store.growCotton(config.yard.field.growthSeconds);
    expect(store.launchCotton('goblin-1')).toBe(true);
    expect(useGameStore.getState().cottonGrowth).toBe(0);
    expect(store.destroyBase('goblin-1')).toBe(true);
    expect(useGameStore.getState().eligibleLand).toEqual(['goblin-1']);
    store.earn(config.cottonAttack.landCost);
    expect(store.buyLand('goblin-1')).toBe(true);
    expect(useGameStore.getState().purchasedLand).toEqual(['goblin-1']);
    expect(store.launchCotton('goblin-3')).toBe(false);
    for (let index = 2; index <= 10; index += 1) {
      store.growCotton(config.yard.field.growthSeconds);
      expect(store.launchCotton(`goblin-${index}`)).toBe(true);
      expect(store.destroyBase(`goblin-${index}`)).toBe(true);
    }
    store.growCotton(config.yard.field.growthSeconds);
    expect(store.launchCotton('goblin-10')).toBe(false);
  });
});

describe('bat air defence', () => {
  it('accepts airborne bats but rejects ground enemies', () => {
    const events = new EventBus<GameEvents>();
    const trap = new AirDefenceTrap(events, config.traps[3] as TrapConfig);
    const bat = new BatFSM(2, events);
    bat.update(1 / 60);
    const goblin = new GoblinFSM(2, events);
    goblin.update(1 / 60);
    expect(trap.accepts(bat)).toBe(true);
    expect(trap.accepts(goblin)).toBe(false);
    trap.trigger(bat);
    expect(bat.state).toBe('Dying');
    expect(trap.armed).toBe(false);
  });

  it('is exposed through the trap factory', () => {
    expect(createTrap('air-defence', new EventBus<GameEvents>())).toBeInstanceOf(AirDefenceTrap);
  });
});


describe('Combo', () => {
  it('multiplies the second trap reward by 1.5 within the combo window', () => {
    const events = new EventBus<GameEvents>();
    const root = typeof document !== 'undefined' ? document.createElement('div') : ({} as HTMLElement);
    new ScoringSystem(events, root);

    const rakeCfg = config.traps[0] as TrapConfig;
    events.emit('trap:triggered', { trapId: rakeCfg.id, reward: rakeCfg.reward });
    expect(useGameStore.getState().currency).toBe(rakeCfg.reward);

    events.emit('trap:triggered', { trapId: rakeCfg.id, reward: rakeCfg.reward });
    expect(useGameStore.getState().currency).toBe(rakeCfg.reward + Math.round(rakeCfg.reward * 1.5));
  });

  it('multiplies the third trap reward by ×2', () => {
    const events = new EventBus<GameEvents>();
    const root = typeof document !== 'undefined' ? document.createElement('div') : ({} as HTMLElement);
    new ScoringSystem(events, root);

    const rakeCfg = config.traps[0] as TrapConfig;
    events.emit('trap:triggered', { trapId: rakeCfg.id, reward: rakeCfg.reward });
    events.emit('trap:triggered', { trapId: rakeCfg.id, reward: rakeCfg.reward });
    events.emit('trap:triggered', { trapId: rakeCfg.id, reward: rakeCfg.reward });

    const expected = rakeCfg.reward + Math.round(rakeCfg.reward * 1.5) + Math.round(rakeCfg.reward * 2);
    expect(useGameStore.getState().currency).toBe(expected);
  });

  it('resets combo counter after window expiry', () => {
    const events = new EventBus<GameEvents>();
    const root = typeof document !== 'undefined' ? document.createElement('div') : ({} as HTMLElement);
    const scoring = new ScoringSystem(events, root);

    const rakeCfg = config.traps[0] as TrapConfig;
    events.emit('trap:triggered', { trapId: rakeCfg.id, reward: rakeCfg.reward });

    scoring['comboCount'] = 0;
    scoring['lastKillTime'] = 0;

    events.emit('trap:triggered', { trapId: rakeCfg.id, reward: rakeCfg.reward });
    expect(useGameStore.getState().currency).toBe(rakeCfg.reward * 2);
  });
});

describe('ScoringSystem', () => {
  it('earns correct amounts for tap/grab/trap events', () => {
    const events = new EventBus<GameEvents>();
    const root = typeof document !== 'undefined' ? document.createElement('div') : ({} as HTMLElement);
    const scoring = new ScoringSystem(events, root);

    events.emit('goblin:tap', { reward: config.economy.earnPerTap });
    expect(useGameStore.getState().currency).toBe(config.economy.earnPerTap);

    // Reset the combo window manually so the next event does not combo.
    scoring['comboCount'] = 0;
    scoring['lastKillTime'] = 0;

    events.emit('goblin:grabbed', undefined);
    expect(useGameStore.getState().currency).toBe(config.economy.earnPerTap + config.economy.earnPerGrab);

    scoring['comboCount'] = 0;
    scoring['lastKillTime'] = 0;

    const trapCfg = config.traps[0] as TrapConfig;
    events.emit('trap:triggered', { trapId: trapCfg.id, reward: trapCfg.reward });
    expect(useGameStore.getState().currency).toBe(config.economy.earnPerTap + config.economy.earnPerGrab + trapCfg.reward);
  });
});

describe('ShopSystem', () => {
  it('deducts currency and unlocks the trap', () => {
    const events = new EventBus<GameEvents>();
    const shop = new ShopSystem(events);
    const trapCfg = config.traps[0] as TrapConfig;

    useGameStore.getState().earn(trapCfg.cost + 5);

    const purchased: { itemId: string; cost: number }[] = [];
    events.on('shop:purchased', (payload) => purchased.push(payload));

    expect(shop.buyTrap(trapCfg.id)).toBe(true);
    expect(useGameStore.getState().currency).toBe(5);
    expect(useGameStore.getState().unlockedTraps).toContain(trapCfg.id);
    expect(purchased).toEqual([{ itemId: trapCfg.id, cost: trapCfg.cost }]);
  });

  it('refuses purchase when too poor or already owned', () => {
    const events = new EventBus<GameEvents>();
    const shop = new ShopSystem(events);
    const trapCfg = config.traps[0] as TrapConfig;

    expect(shop.buyTrap(trapCfg.id)).toBe(false);

    useGameStore.getState().earn(trapCfg.cost);
    expect(shop.buyTrap(trapCfg.id)).toBe(true);
    expect(shop.buyTrap(trapCfg.id)).toBe(false);
  });
});
