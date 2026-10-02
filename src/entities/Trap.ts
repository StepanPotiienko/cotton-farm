import * as THREE from 'three';
import type { GoblinFSM } from './Goblin';
import type { EventBus, GameEvents } from '../core/Events';
import type RAPIER from '@dimforge/rapier3d-compat';
import { useGameStore } from '../state/store';
import config from '../state/config/game.json';

export interface TrapConfig {
  id: string;
  cost: number;
  nameKey: string;
  triggerRadius: number;
  resetSeconds: number;
  reward: number;
  launchImpulse?: { x: number; y: number; z: number };
  haystackOffset?: { x: number; y: number; z: number };
  swingTime?: number;
  swingFrom?: number;
  swingTo?: number;
}

const trapConfigMap = new Map<string, TrapConfig>(config.traps.map((t) => [t.id, t as TrapConfig]));

export abstract class Trap {
  id: string;
  nameKey: string;
  cost: number;
  triggerRadius: number;
  resetSeconds: number;
  reward: number;
  triggered = false;
  readonly group: THREE.Group;
  armed = true;
  protected elapsed = 0;

  constructor(
    protected readonly events: EventBus<GameEvents>,
    configEntry: TrapConfig,
  ) {
    this.id = configEntry.id;
    this.nameKey = configEntry.nameKey;
    this.cost = configEntry.cost;
    this.triggerRadius = configEntry.triggerRadius;
    this.resetSeconds = configEntry.resetSeconds;
    this.reward = configEntry.reward;
    this.group = new THREE.Group();
  }

  place(position: THREE.Vector3, rotation = 0): void {
    this.group.position.copy(position);
    this.group.rotation.y = rotation;
  }

  abstract update(delta: number): void;

  abstract trigger(goblinFSM: GoblinFSM, body?: RAPIER.RigidBody): void;

  accepts(fsm: GoblinFSM): boolean { return !fsm.airborne; }

  hitGoblin(goblinFSM: GoblinFSM): void {
    if (this.armed && (goblinFSM.state === 'Sneak' || goblinFSM.state === 'Grab')) {
      goblinFSM.hit();
    }
  }

  dispose(): void {
    this.group.clear();
  }

  protected emitTriggered(): void {
    this.triggered = true;
    this.armed = false;
    this.elapsed = 0;
    this.events.emit('trap:triggered', { trapId: this.id, reward: this.reward });
  }

  protected resetArmed(): void {
    this.triggered = false;
    this.armed = true;
    this.elapsed = 0;
  }
}

export class RakeTrap extends Trap {
  private handle: THREE.Group;
  private restRotation = 0;
  private flipRotation = Math.PI / 2;

  constructor(events: EventBus<GameEvents>, configEntry: TrapConfig = trapConfigMap.get('rake') ?? config.traps[0] as TrapConfig) {
    super(events, configEntry);
    this.handle = this.buildRake();
    this.group.add(this.handle);
  }

  place(position: THREE.Vector3, rotation = 0): void {
    super.place(position, rotation);
    this.handle.rotation.x = this.armed ? this.restRotation : this.flipRotation;
  }

  update(delta: number): void {
    if (!this.armed) {
      this.elapsed += delta;
      const t = Math.min(this.elapsed / Math.max(this.resetSeconds, 0.001), 1);
      // Spring back: fast initial flip up, then settle down over resetSeconds.
      this.handle.rotation.x = THREE.MathUtils.lerp(this.flipRotation, this.restRotation, t * t);
      if (t >= 1) {
        this.resetArmed();
        this.handle.rotation.x = this.restRotation;
      }
    }
  }

  trigger(goblinFSM: GoblinFSM, body?: RAPIER.RigidBody): void {
    if (!this.armed || !this.accepts(goblinFSM) || (goblinFSM.state !== 'Idle' && goblinFSM.state !== 'Sneak' && goblinFSM.state !== 'Grab')) return;
    this.hitGoblin(goblinFSM);
    if (body && body.mass && body.mass() > 0) {
      const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(this.group.quaternion).normalize();
      body.applyImpulse({ x: direction.x * 3, y: 1.8, z: direction.z * 3 }, true);
    }
    this.handle.rotation.x = this.flipRotation;
    this.emitTriggered();
  }

  private buildRake(): THREE.Group {
    const g = new THREE.Group();
    // Handle
    const handleGeo = new THREE.CylinderGeometry(0.035, 0.045, 0.9, 6);
    const wood = this.rendererToon('#8f5e42');
    const handle = new THREE.Mesh(handleGeo, wood);
    handle.position.y = 0.45;
    handle.castShadow = true;
    g.add(handle);
    // Head
    const headGeo = new THREE.BoxGeometry(0.42, 0.06, 0.04);
    const head = new THREE.Mesh(headGeo, this.rendererToon('#6b6b6b'));
    head.position.y = 0.9;
    head.castShadow = true;
    g.add(head);
    // Tines
    const tineGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.22, 4);
    const tineMat = this.rendererToon('#7a7a7a');
    for (let i = 0; i < 5; i += 1) {
      const tine = new THREE.Mesh(tineGeo, tineMat);
      tine.position.set(-0.15 + i * 0.075, 0.78, 0.02);
      tine.castShadow = true;
      g.add(tine);
    }
    // Pivot at ground so rotation lifts the head.
    g.position.y = 0.04;
    return g;
  }

  private rendererToon(color: string): THREE.MeshToonMaterial {
    const data = new Uint8Array([48, 118, 190, 255]);
    const gradient = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
    gradient.needsUpdate = true;
    return new THREE.MeshToonMaterial({ color, gradientMap: gradient });
  }
}

export class HaystackLauncher extends Trap {
  private plate: THREE.Group;
  private haystack: THREE.Group;
  private launch: { x: number; y: number; z: number };

  constructor(events: EventBus<GameEvents>, configEntry: TrapConfig = trapConfigMap.get('haystack') ?? config.traps[1] as TrapConfig) {
    super(events, configEntry);
    this.launch = configEntry.launchImpulse ?? { x: 0, y: 4, z: 2 };
    this.plate = this.buildPlate();
    this.haystack = this.buildHaystack();
    this.group.add(this.plate);
    this.group.add(this.haystack);
    const offset = configEntry.haystackOffset ?? { x: 0, y: 0, z: 1.2 };
    this.haystack.position.set(offset.x, offset.y, offset.z);
  }

  update(delta: number): void {
    if (!this.armed) {
      this.elapsed += delta;
      const t = Math.min(this.elapsed / Math.max(this.resetSeconds, 0.001), 1);
      this.plate.position.y = THREE.MathUtils.lerp(0.12, 0.04, t);
      if (t >= 1) this.resetArmed();
    }
  }

  trigger(goblinFSM: GoblinFSM, body?: RAPIER.RigidBody): void {
    if (!this.armed || !this.accepts(goblinFSM) || (goblinFSM.state !== 'Sneak' && goblinFSM.state !== 'Grab')) return;
    this.hitGoblin(goblinFSM);
    if (body && body.mass && body.mass() > 0) {
      body.applyImpulse(this.launch, true);
    }
    this.plate.position.y = 0.12;
    this.emitTriggered();
  }

  private buildPlate(): THREE.Group {
    const g = new THREE.Group();
    const wood = this.rendererToon('#8f5e42');
    const platform = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.04, 0.56), wood);
    platform.position.y = 0.02;
    platform.castShadow = true;
    g.add(platform);
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.03, 6, 12), this.rendererToon('#5a5a5a'));
    coil.rotation.x = Math.PI / 2;
    coil.position.y = 0.06;
    coil.castShadow = true;
    g.add(coil);
    const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.14, 5), this.rendererToon('#6b6b6b'));
    peg.position.y = 0.09;
    peg.castShadow = true;
    g.add(peg);
    return g;
  }

  private buildHaystack(): THREE.Group {
    const g = new THREE.Group();
    const hay = this.rendererToon('#d9a83f');
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 0.3, 7), hay);
    base.position.y = 0.15;
    base.castShadow = true;
    g.add(base);
    const mid = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 0.25, 7), hay);
    mid.position.y = 0.38;
    mid.castShadow = true;
    g.add(mid);
    const top = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.3, 7), hay);
    top.position.y = 0.62;
    top.castShadow = true;
    g.add(top);
    return g;
  }

  private rendererToon(color: string): THREE.MeshToonMaterial {
    const data = new Uint8Array([48, 118, 190, 255]);
    const gradient = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
    gradient.needsUpdate = true;
    return new THREE.MeshToonMaterial({ color, gradientMap: gradient });
  }
}

export class FryingPanTrap extends Trap {
  private arm: THREE.Group;
  private pan: THREE.Group;
  private swingTime: number;
  private swingFrom: number;
  private swingTo: number;
  private swinging = false;
  private swingElapsed = 0;

  constructor(events: EventBus<GameEvents>, configEntry: TrapConfig = trapConfigMap.get('pan') ?? config.traps[2] as TrapConfig) {
    super(events, configEntry);
    this.swingTime = configEntry.swingTime ?? 0.25;
    this.swingFrom = configEntry.swingFrom ?? -0.6;
    this.swingTo = configEntry.swingTo ?? 1.4;
    this.arm = this.buildArm();
    this.pan = this.buildPan();
    this.group.add(this.arm);
    this.group.add(this.pan);
  }

  place(position: THREE.Vector3, rotation = 0): void {
    super.place(position, rotation);
    this.pan.rotation.z = this.swingFrom;
  }

  update(delta: number): void {
    if (!this.armed) {
      this.elapsed += delta;
      if (this.swinging) {
        this.swingElapsed += delta;
        const t = Math.min(this.swingElapsed / Math.max(this.swingTime, 0.001), 1);
        // Swing forward then back: 0..0.5 forward, 0.5..1 back.
        const phase = t <= 0.5 ? t * 2 : 2 - (t - 0.5) * 2;
        this.pan.rotation.z = THREE.MathUtils.lerp(this.swingFrom, this.swingTo, phase);
        if (t >= 1) this.swinging = false;
      }
      if (this.elapsed >= this.resetSeconds) this.resetArmed();
    }
  }

  trigger(goblinFSM: GoblinFSM, body?: RAPIER.RigidBody): void {
    if (!this.armed || !this.accepts(goblinFSM) || (goblinFSM.state !== 'Sneak' && goblinFSM.state !== 'Grab')) return;
    this.hitGoblin(goblinFSM);
    this.swinging = true;
    this.swingElapsed = 0;
    this.emitTriggered();
  }

  private buildArm(): THREE.Group {
    const g = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.1, 5), this.rendererToon('#5a4a3a'));
    post.position.y = 0.55;
    post.castShadow = true;
    g.add(post);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.7, 5), this.rendererToon('#5a4a3a'));
    beam.rotation.z = Math.PI / 2;
    beam.position.set(0.35, 1.05, 0);
    beam.castShadow = true;
    g.add(beam);
    return g;
  }

  private panMat = this.rendererToon('#2f2f2f');
  private buildPan(): THREE.Group {
    const g = new THREE.Group();
    g.position.set(0.7, 1.05, 0);
    const pan = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.2, 0.04, 10), this.panMat);
    pan.rotation.x = Math.PI / 2;
    pan.castShadow = true;
    g.add(pan);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.35, 5), this.rendererToon('#7a7a7a'));
    handle.rotation.z = Math.PI / 2;
    handle.position.x = -0.28;
    handle.castShadow = true;
    g.add(handle);
    return g;
  }

  private rendererToon(color: string): THREE.MeshToonMaterial {
    const data = new Uint8Array([48, 118, 190, 255]);
    const gradient = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
    gradient.needsUpdate = true;
    return new THREE.MeshToonMaterial({ color, gradientMap: gradient });
  }
}

export class AirDefenceTrap extends Trap {
  private readonly radar: THREE.Mesh;
  constructor(events: EventBus<GameEvents>, entry: TrapConfig = trapConfigMap.get('air-defence')!) {
    super(events, entry);
    const material = new THREE.MeshToonMaterial({ color: '#75b4cf' });
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.15, 1.1, 6), material);
    mast.position.y = 0.55;
    this.radar = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.07, 6, 12), material);
    this.radar.position.y = 1.2;
    this.group.add(mast, this.radar);
  }
  override accepts(fsm: GoblinFSM): boolean { return fsm.airborne; }
  trigger(fsm: GoblinFSM): void {
    if (!this.armed || !this.accepts(fsm) || (fsm.state !== 'Sneak' && fsm.state !== 'Grab')) return;
    this.hitGoblin(fsm);
    this.radar.scale.setScalar(1.6);
    this.emitTriggered();
  }
  update(delta: number): void {
    this.radar.rotation.y += delta * 3;
    if (!this.armed) {
      this.elapsed += delta;
      this.radar.scale.setScalar(1 + 0.6 * Math.max(0, 1 - this.elapsed / this.resetSeconds));
      if (this.elapsed >= this.resetSeconds) this.resetArmed();
    }
  }
}

export function createTrap(id: string, events: EventBus<GameEvents>): Trap {
  const cfg = trapConfigMap.get(id);
  if (!cfg) throw new Error(`Unknown trap id: ${id}`);
  switch (id) {
    case 'air-defence': return new AirDefenceTrap(events, cfg);
    case 'rake': return new RakeTrap(events, cfg);
    case 'haystack': return new HaystackLauncher(events, cfg);
    case 'pan': return new FryingPanTrap(events, cfg);
    default: throw new Error(`Unknown trap id: ${id}`);
  }
}

export function getTrapConfig(id: string): TrapConfig | undefined {
  return trapConfigMap.get(id);
}

export function isTrapUnlocked(id: string): boolean {
  return useGameStore.getState().unlockedTraps.includes(id);
}
