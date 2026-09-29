import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GameControls } from './controls';
import type { Game } from './Game';
import { useGameStore } from '../state/store';
import config from '../state/config/game.json';

interface MockGame {
  actors: unknown[];
  freeActors: unknown[];
  running: boolean;
  spawnGoblin: ReturnType<typeof vi.fn>;
  killAllGoblins: ReturnType<typeof vi.fn>;
  tick: ReturnType<typeof vi.fn>;
}

function createMockGame(): Game {
  return {
    actors: [],
    freeActors: [],
    running: true,
    spawnGoblin: vi.fn(),
    killAllGoblins: vi.fn(() => 0),
    tick: vi.fn(),
  } as unknown as Game;
}

const getMock = (game: Game) => game as unknown as MockGame;

describe('GameControls', () => {
  beforeEach(() => {
    useGameStore.getState().spend(useGameStore.getState().currency);
    useGameStore.getState().earn(config.economy.startingCurrency);
  });

  it('spawnGoblin calls game.spawnGoblin count times and returns count', () => {
    const mockGame = createMockGame();
    const controls = new GameControls(mockGame);
    expect(controls.spawnGoblin(3)).toBe(3);
    expect(getMock(mockGame).spawnGoblin).toHaveBeenCalledTimes(3);
  });

  it('killAllGoblins returns result from game.killAllGoblins', () => {
    const mockGame = createMockGame();
    const controls = new GameControls(mockGame);
    getMock(mockGame).killAllGoblins.mockReturnValue(7);
    expect(controls.killAllGoblins()).toBe(7);
  });

  it('pause prevents tick from being called; resume restores it', () => {
    const mockGame = createMockGame();
    const controls = new GameControls(mockGame);
    const originalTick = getMock(mockGame).tick;
    controls.pause();
    getMock(mockGame).tick(42);
    expect(originalTick).not.toHaveBeenCalled();
    vi.clearAllMocks();
    controls.resume();
    expect(originalTick).toHaveBeenCalledTimes(1);
  });

  it('setTimeScale(2) makes tick receive doubled delta', () => {
    const mockGame = createMockGame();
    const controls = new GameControls(mockGame);
    const originalTick = getMock(mockGame).tick;
    controls.setTimeScale(2);
    getMock(mockGame).tick(1000);
    getMock(mockGame).tick(1100);
    expect(originalTick).toHaveBeenCalledTimes(2);
    const first = originalTick.mock.calls[0][0];
    const second = originalTick.mock.calls[1][0];
    expect(second - first).toBe(200);
  });

  it('earn increases store currency', () => {
    const controls = new GameControls(createMockGame());
    const start = useGameStore.getState().currency;
    controls.earn(10);
    expect(useGameStore.getState().currency).toBe(start + 10);
  });

  it('resetCurrency returns store currency to starting value', () => {
    const controls = new GameControls(createMockGame());
    controls.earn(25);
    controls.resetCurrency();
    expect(useGameStore.getState().currency).toBe(config.economy.startingCurrency);
  });

  it('getSummary reflects mocked state', () => {
    const mockGame = createMockGame();
    const controls = new GameControls(mockGame);
    getMock(mockGame).actors.push({} as never, {} as never);
    getMock(mockGame).freeActors.push({} as never);
    getMock(mockGame).running = true;
    controls.pause();
    const summary = controls.getSummary();
    expect(summary).toEqual({
      actorCount: 2,
      freeActors: 1,
      paused: true,
      timeScale: 1,
      currency: useGameStore.getState().currency,
      isRunning: true,
    });
  });
});
