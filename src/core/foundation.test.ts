import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EnemyBase, nearestActiveBase } from '../entities/EnemyBase';
import { BatFSM, GoblinFSM, OrcFSM } from '../entities/Goblin';
import { AirDefenceTrap, createTrap } from '../entities/Trap';
import { useGameStore } from '../state/store';
import { EventBus, type GameEvents } from './Events';
import { defaultSave, saveGame, validateSave, restoreGame } from './Save';
import { Game } from './Game';
import { ShopSystem } from '../systems/ShopSystem';
import config from '../state/config/game.json';

beforeEach(() => useGameStore.getState().resetStore());
const mature = () => useGameStore.getState().growCotton(config.yard.field.growthSeconds);
const base = (id: string, x: number) => new EnemyBase(id, '#777', x, 0, (color) => new THREE.MeshToonMaterial({ color }));

describe('cotton attack foundation', () => {
  it('selects the nearest active, unreserved, undestroyed base below its side cap', () => {
    const bases = [base('goblin-1', 5), base('orc-1', 2), base('goblin-2', 1)];
    bases[2]!.active = false;
    expect(nearestActiveBase(bases, new THREE.Vector3(), { goblin: 0, orc: 0 })).toBe(bases[1]);
    bases[1]!.targeted = true;
    expect(nearestActiveBase(bases, new THREE.Vector3(), { goblin: 0, orc: 0 })).toBe(bases[0]);
    bases[1]!.destroy();
    expect(nearestActiveBase(bases, new THREE.Vector3(), { goblin: 10, orc: 0 })).toBeUndefined();
    bases.forEach((b) => b.dispose());
  });
  it('resets mature cotton only on a successful launch, reserves targets, and unlocks land on impact', () => {
    expect(useGameStore.getState().launchCotton('goblin-1')).toBe(false);
    mature();
    expect(useGameStore.getState().launchCotton('goblin-2')).toBe(false);
    expect(useGameStore.getState().cottonGrowth).toBe(1);
    expect(useGameStore.getState().launchCotton('goblin-1')).toBe(true);
    expect(useGameStore.getState().cottonGrowth).toBe(0);
    expect(useGameStore.getState().eligibleLand).toEqual([]);
    mature();
    expect(useGameStore.getState().launchCotton('goblin-1')).toBe(false);
    expect(useGameStore.getState().destroyBase('goblin-1')).toBe(true);
    expect(useGameStore.getState().destroyBase('goblin-1')).toBe(false);
    expect(useGameStore.getState().eligibleLand).toEqual(['goblin-1']);
    expect(useGameStore.getState().launchCotton('goblin-1')).toBe(false);
  });
  it('enforces ten attacks and destructions independently for both sides', () => {
    for (const side of ['goblin', 'orc'] as const) {
      for (let i = 1; i <= 10; i++) {
        mature();
        expect(useGameStore.getState().launchCotton(`${side}-${i}`)).toBe(true);
        expect(useGameStore.getState().destroyBase(`${side}-${i}`)).toBe(true);
      }
      mature();
      expect(useGameStore.getState().launchCotton(`${side}-11`)).toBe(false);
    }
    expect(useGameStore.getState().attacks).toEqual({ goblin: 10, orc: 10 });
    expect(useGameStore.getState().destroyedCounts).toEqual({ goblin: 10, orc: 10 });
  });
  it('emits impact/unlock events and activates the next base only after flight completion', () => {
    const bases = [base('goblin-1', 3), base('goblin-2', 3)];
    bases[1]!.active = false;
    const events = new EventBus<GameEvents>();
    const emitted: string[] = [];
    events.on('base:destroyed', ({ baseId }) => emitted.push(baseId));
    events.on('land:unlocked', ({ landId }) => emitted.push(landId));
    const game = Object.create(Game.prototype) as Game;
    Object.assign(game, { bases, baseReveals: new Map(), flights: [], events, renderer: { root: new THREE.Group(), toon: (color: THREE.ColorRepresentation) => new THREE.MeshToonMaterial({ color }) } });
    mature();
    expect(game.launchCotton()).toBe(true);
    const step = (game as unknown as { stepCottonFlights(delta: number): void }).stepCottonFlights.bind(game);
    step(config.cottonAttack.flightSeconds / 2);
    expect(bases[0]!.destroyed).toBe(false);
    step(config.cottonAttack.flightSeconds);
    expect(bases[0]!.destroyed).toBe(true);
    expect(bases[1]!.active).toBe(true);
    expect(emitted).toEqual(['goblin-1', 'goblin-1']);
    bases.forEach((b) => b.dispose());
  });
  it('allows each unlocked land purchase once and preserves progression in saves', () => {
    const events = new EventBus<GameEvents>();
    const shop = new ShopSystem(events);
    useGameStore.getState().earn(1000);
    expect(shop.buyLand('orc-1')).toBe(false);
    mature(); useGameStore.getState().launchCotton('orc-1'); useGameStore.getState().destroyBase('orc-1');
    expect(shop.buyLand('orc-1')).toBe(true);
    expect(shop.buyLand('orc-1')).toBe(false);
    const saved = saveGame({ setItem: () => {} });
    expect(validateSave(saved)).toBe(true);
    expect(restoreGame(saved)).toBe(true);
    expect(useGameStore.getState().purchasedLand).toEqual(['orc-1']);
    saved.attackProgress!.attacks.orc = 11;
    expect(validateSave(saved)).toBe(false);
    const legacy = defaultSave(); delete legacy.attackProgress;
    expect(validateSave(legacy)).toBe(true);
  });
});

describe('bats and air defence', () => {
  it('keeps the theft and defeat cycle while disabling the ground spring', () => {
    const bat = new BatFSM(); bat.reset('Idle'); bat.update(0.1); bat.update(0.1, 0.5);
    expect(bat.state).toBe('Grab'); expect(bat.springEnabled).toBe(false);
    bat.hit(); expect(bat.state).toBe('Dying');
    bat.update(config.goblin.dyingSeconds); expect(bat.state).toBe('Idle');
    expect(bat.airborne).toBe(true);
    expect(new GoblinFSM().airborne).toBe(false); expect(new OrcFSM().airborne).toBe(false);
  });
  it('defeats bats once per reset and never consumes itself or rewards ground enemies', () => {
    const events = new EventBus<GameEvents>(); let rewards = 0;
    events.on('trap:triggered', () => rewards++);
    const trap = createTrap('air-defence', events);
    expect(trap).toBeInstanceOf(AirDefenceTrap);
    for (const fsm of [new GoblinFSM(), new OrcFSM()]) {
      fsm.reset('Sneak'); trap.trigger(fsm); expect(fsm.state).toBe('Sneak');
    }
    expect(trap.armed).toBe(true); expect(rewards).toBe(0);
    const bat = new BatFSM(); bat.reset('Sneak'); trap.trigger(bat); trap.trigger(bat);
    expect(bat.state).toBe('Dying'); expect(rewards).toBe(1);
    trap.update(trap.resetSeconds); expect(trap.armed).toBe(true);
    bat.reset('Sneak'); trap.trigger(bat); expect(rewards).toBe(2);
    trap.dispose();
  });
  it('covers configured factories and excludes bats from ground traps', () => {
    const events = new EventBus<GameEvents>();
    for (const entry of config.traps) {
      const trap = createTrap(entry.id, events);
      expect(trap.cost).toBe(entry.cost);
      expect(trap.group.children.length).toBeGreaterThan(0);
      if (entry.id !== 'air-defence') {
        const bat = new BatFSM(); bat.reset('Sneak'); trap.trigger(bat);
        expect(bat.state).toBe('Sneak'); expect(trap.armed).toBe(true);
      }
      trap.dispose();
    }
    useGameStore.getState().earn(1000);
    const shop = new ShopSystem(events);
    expect(shop.buyTrap('air-defence')).toBe(true);
    expect(shop.buyTrap('air-defence')).toBe(false);
  });
});
