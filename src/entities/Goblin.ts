import type { EventBus, GameEvents } from '../core/Events';
import { createRng } from '../core/random';
import config from '../state/config/game.json';

export type GoblinState = 'Idle' | 'Sneak' | 'Grab' | 'Flee' | 'Stunned' | 'Recover' | 'Dying';
export class GoblinFSM {
  state: GoblinState = 'Idle';
  elapsed = 0;
  springEnabled = true;
  readonly rng: () => number;
  constructor(seed = 1, private readonly events?: EventBus<GameEvents>) { this.rng = createRng(seed); }
  reset(state: GoblinState): void {
    this.state = state;
    this.elapsed = 0;
    this.springEnabled = true;
  }
  transition(state: GoblinState): void {
    this.state = state;
    this.elapsed = 0;
    this.events?.emit('goblin:state', { state });
    if (state === 'Grab') this.events?.emit('goblin:grabbed', undefined);
    if (state === 'Stunned') this.springEnabled = false;
    if (state === 'Recover') this.springEnabled = true;
    if (state === 'Dying') this.springEnabled = false;
  }
  hit(): void {
    if (this.state === 'Sneak' || this.state === 'Grab') this.transition('Dying');
  }
  update(delta: number, distanceToPot = 4, offscreen = false): void {
    this.elapsed += delta;
    switch (this.state) {
      case 'Idle': this.transition('Sneak'); break;
      case 'Sneak': if (distanceToPot <= config.goblin.grabDistance) this.transition('Grab'); break;
      case 'Grab': if (this.elapsed >= config.goblin.grabSeconds) this.transition('Flee'); break;
      case 'Flee': if (offscreen) this.transition('Dying'); break;
      case 'Stunned': if (this.elapsed >= config.goblin.stunSeconds) this.transition('Recover'); break;
      case 'Recover': if (this.elapsed >= config.goblin.recoverSeconds) this.transition('Sneak'); break;
      case 'Dying': if (this.elapsed >= config.goblin.dyingSeconds) this.transition('Idle'); break;
    }
  }
}

/** Orcs use the same gentle slapstick state machine as goblins. */
export class OrcFSM extends GoblinFSM {}

/** Pure spawn pacing: returns true when a new goblin should enter the yard. */
export class GoblinSpawner {
  private timer: number;
  constructor(
    private readonly rng: () => number,
    firstDelaySeconds = config.goblin.spawn.delayMinSeconds * 0.2,
  ) { this.timer = firstDelaySeconds; }
  update(delta: number, activeCount: number, maxActive: number): boolean {
    if (activeCount >= maxActive) return false;
    this.timer -= delta;
    if (this.timer > 0) return false;
    this.timer = config.goblin.spawn.delayMinSeconds + this.rng() * (config.goblin.spawn.delayMaxSeconds - config.goblin.spawn.delayMinSeconds);
    return true;
  }
}