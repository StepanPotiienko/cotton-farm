import { useGameStore } from '../state/store';
import type { Game } from './Game';

interface GameInternals {
  actors: unknown[];
  freeActors: unknown[];
  running: boolean;
  tick: (now: number) => void;
}

export class GameControls {
  paused = false;
  timeScale = 1;
  private originalTick: ((now: number) => void) | null = null;

  constructor(private readonly game: Game) {}

  spawnGoblin(count = 1): number {
    let spawned = 0;
    for (let i = 0; i < count; i += 1) {
      (this.game as unknown as { spawnGoblin(): void }).spawnGoblin();
      spawned += 1;
    }
    return spawned;
  }

  killAllGoblins(): number {
    return (this.game as unknown as { killAllGoblins(): number }).killAllGoblins();
  }

  pause(): void {
    if (this.paused) return;
    const g = this.game as unknown as GameInternals;
    this.originalTick = g.tick.bind(this.game);
    g.tick = () => {};
    this.paused = true;
  }

  resume(): void {
    if (!this.paused || !this.originalTick) return;
    const g = this.game as unknown as GameInternals;
    g.tick = this.originalTick;
    this.originalTick = null;
    this.paused = false;
    this.timeScale = 1;
    if (typeof performance !== 'undefined') g.tick(performance.now());
  }

  setTimeScale(scale: number): void {
    if (!Number.isFinite(scale) || scale < 0) throw new Error('Time scale must be a non-negative finite number');
    const wasPaused = this.paused;
    if (wasPaused) this.resume();
    const g = this.game as unknown as GameInternals;
    const baseTick = this.originalTick ?? g.tick.bind(this.game);
    if (!this.originalTick) this.originalTick = baseTick;
    const previousScale = this.timeScale;
    this.timeScale = scale;
    if (scale === 0) {
      g.tick = () => {};
      this.paused = true;
      return;
    }
    let lastNow = performance.now();
    let scaledLastTime = lastNow;
    g.tick = (now: number) => {
      if (scale !== this.timeScale) {
        baseTick(now);
        return;
      }
      const realDelta = now - lastNow;
      lastNow = now;
      const scaledNow = scaledLastTime + realDelta * scale;
      scaledLastTime = scaledNow;
      baseTick(scaledNow);
    };
    if (wasPaused) this.paused = false;
  }

  earn(amount: number): void {
    useGameStore.getState().earn(amount);
  }

  resetCurrency(): void {
    const state = useGameStore.getState();
    const cur = state.currency;
    if (cur > 0) state.spend(cur);
  }

  getSummary(): { actorCount: number; freeActors: number; paused: boolean; timeScale: number; currency: number; isRunning: boolean } {
    const g = this.game as unknown as GameInternals;
    return {
      actorCount: g.actors.length,
      freeActors: g.freeActors.length,
      paused: this.paused,
      timeScale: this.timeScale,
      currency: useGameStore.getState().currency,
      isRunning: g.running,
    };
  }
}
