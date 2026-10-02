import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { EventBus, type GameEvents } from './Events';
import { Physics } from './Physics';
import { createRng } from './random';
import { Renderer } from './Renderer';
import { GoblinFSM, GoblinSpawner, OrcFSM, BatFSM } from '../entities/Goblin';
import { EnemyBase, nearestActiveBase } from '../entities/EnemyBase';
import { createTrap, getTrapConfig, type Trap } from '../entities/Trap';
import { ScoringSystem } from '../systems/ScoringSystem';
import { ShopSystem } from '../systems/ShopSystem';
import { decorationLimit, useGameStore } from '../state/store';
import { setShopSystem } from '../ui/hud';
import config from '../state/config/game.json';
import { getLandSlots, getIslandLayout, LAND_SIZE, isOnYard } from './LandLayout';

interface GoblinActor {
  kind: 'goblin' | 'orc' | 'bat';
  fsm: GoblinFSM;
  body: RAPIER.RigidBody;
  group: THREE.Group;
  squash: THREE.Group;
  stars: THREE.Group;
  walkPhase: number;
  speed: number;
}

interface ActorVisuals { group: THREE.Group; squash: THREE.Group; stars: THREE.Group; body: THREE.Mesh; }

export function getCursorKnockbackImpulse(actorPosition: THREE.Vector3, cursorOrigin: THREE.Vector3, strength: number): { x: number; y: number; z: number } {
  const away = actorPosition.clone().sub(cursorOrigin).setY(0);
  if (away.lengthSq() < 0.0001) away.set(0, 0, 1);
  away.normalize();
  return { x: away.x * strength, y: strength * 0.5, z: away.z * strength };
}

/** Yaw for an actor whose local forward direction is +Z; null leaves non-movement poses alone. */
export function getActorFacingYaw(state: string, actorX: number, actorZ: number, targetX: number, targetZ: number): number | null {
  if (state === 'Sneak' || state === 'Grab') {
    return Math.atan2(targetX - actorX, targetZ - actorZ);
  }
  if (state === 'Flee') return 0;
  return null;
}

export function canSelectTrapForPlacement(id: string, unlockedIds: string[], placedIds: string[]): boolean {
  return unlockedIds.includes(id) && !placedIds.includes(id);
}

export function isValidTrapPlacement(x: number, z: number): boolean {
  return isOnYard(x, z);
}

export function getFieldTilePositions(): number[] {
  const { tileCountPerSide, tileSpacing } = config.yard.field;
  return Array.from({ length: tileCountPerSide * 2 + 1 }, (_, index) => (index - tileCountPerSide) * tileSpacing);
}

// Round pedestal cylinder geometry: height 0.62 centered at y=-0.34 keeps the
// visible top face of the platform at y=-0.03 (matching the physics collider top).
const GROUND_SLAB_HEIGHT = 0.62;
const GROUND_CENTER_Y = -0.34;
const GROUND_TOP_Y = GROUND_CENTER_Y + GROUND_SLAB_HEIGHT / 2;
export const FIELD_TILE_THICKNESS = 0.12;

/** Y of the round pedestal's visible top face; the walkable collider tops sit flush at y=0. */
export function getGroundTopY(): number {
  return GROUND_TOP_Y;
}

/** Y of the cotton tile top faces: tiles rest their bottoms exactly on the pedestal surface. */
export function getFieldTileTopY(): number {
  return GROUND_TOP_Y + FIELD_TILE_THICKNESS;
}

export function canHarvestCotton(growth: number): boolean { return growth >= 1; }

export type EnemyKind = 'goblin' | 'orc';
export function getEnemyBasePosition(kind: EnemyKind): { x: number; z: number; y: number } {
  const island = getIslandLayout(kind);
  return { x: island.x, z: island.z, y: island.topY };
}
export function getEnemySpawnKind(spawnIndex: number): EnemyKind {
  return spawnIndex % 2 === 0 ? 'goblin' : 'orc';
}

export class Game {
  readonly events = new EventBus<GameEvents>();
  readonly renderer: Renderer;
  physics!: Physics;
  private accumulator = 0;
  private lastTime = 0;
  private frame = 0;
  running = false;
  actors: GoblinActor[] = [];
  freeActors: GoblinActor[] = [];
  traps: Trap[] = [];
  private flights: { base: EnemyBase; mesh: THREE.Mesh; origin: THREE.Vector3; elapsed: number }[] = [];
  private bases: EnemyBase[] = [];
  private landPlatforms = new Map<string, THREE.Mesh>();
  private landPlatformsUnsubscribe?: () => void;
  private landPhysicsUnsubscribe?: () => void;
  private placedBuildings: THREE.Group[] = [];
  private baseReveals = new Map<EnemyBase, number>();
  private landDecorations = new Map<string, THREE.Group>();
  private landDecorationsUnsubscribe?: () => void;
  private spawner: GoblinSpawner;
  private raycaster = new THREE.Raycaster();
  private pointerDown: { x: number; y: number; t: number } | null = null;
  private decorationDrag: { pointerId: number; item: THREE.Object3D; landId: string; itemId: string; offset: THREE.Vector3; start: THREE.Vector3; moved: boolean } | null = null;
  private selectedTrapId: string | null = null;
  private placementIndicator = new THREE.Group();
  private placementIndicatorRing?: THREE.Mesh;
  private placementIndicatorDisc?: THREE.Mesh;
  private potTarget = new THREE.Vector3(0, 0, config.yard.potPosition[2]);
  private spawnEdgeZ = -config.goblin.spawn.spawnRadius;
  private spawnSequence = 0;
  private visuals?: { capsule: THREE.CapsuleGeometry; orcBody: THREE.CapsuleGeometry; tusk: THREE.ConeGeometry; eye: THREE.SphereGeometry; star: THREE.OctahedronGeometry; bodyMat: THREE.MeshToonMaterial; orcMat: THREE.MeshToonMaterial; tuskMat: THREE.MeshToonMaterial; eyeMat: THREE.MeshToonMaterial; starMat: THREE.MeshToonMaterial };
  private scoringSystem: ScoringSystem;
  private shopSystem: ShopSystem;

  constructor(private readonly mount: HTMLElement, seed = 1337) {
    this.renderer = new Renderer(mount);
    this.spawner = new GoblinSpawner(createRng(seed + 1));
    this.scoringSystem = new ScoringSystem(this.events, mount.parentElement ?? mount);
    this.shopSystem = new ShopSystem(this.events);
    this.createDiorama();
    this.createPlacementIndicator();
    setShopSystem(this.shopSystem, (trapId) => this.selectTrapForPlacement(trapId), (id) => this.selectBuildingForPlacement(id));
    this.bindTap();
  }

  async start(): Promise<void> {
    this.physics = await Physics.create();
    this.physics.floor();
    let supportedProgress: string[] | undefined;
    const syncSupport = () => {
      const destroyed = useGameStore.getState().destroyedBases;
      if (destroyed === supportedProgress) return;
      this.physics.syncLandSupport(destroyed);
      supportedProgress = destroyed;
    };
    syncSupport();
    this.landPhysicsUnsubscribe = useGameStore.subscribe(syncSupport);
    for (let i = 0; i < config.goblin.pool.initialSpawnCount; i += 1) this.spawnActor();
    this.running = true;
    this.lastTime = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
    for (const actor of this.actors) this.renderer.root.remove(actor.group, actor.stars);
    for (const base of this.bases) {
      this.renderer.root.remove(base.group);
      base.dispose();
    }
    this.bases = [];
    this.landPlatformsUnsubscribe?.();
    this.landPhysicsUnsubscribe?.();
    for (const mesh of this.landPlatforms.values()) { this.renderer.root.remove(mesh); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
    this.landPlatforms.clear();
    for (const group of this.placedBuildings) { this.renderer.root.remove(group); group.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } }); }
    this.placedBuildings = [];
    this.baseReveals.clear();
    this.decorationDrag = null;
    this.landDecorationsUnsubscribe?.();
    this.landDecorationsUnsubscribe = undefined;
    for (const [landId, decoration] of this.landDecorations) {
      this.renderer.root.remove(decoration);
      decoration.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.forEach((material) => material.dispose());
        }
      });
      this.landDecorations.delete(landId);
    }
    for (const flight of this.flights) {
      this.renderer.root.remove(flight.mesh);
      flight.mesh.geometry.dispose();
      (flight.mesh.material as THREE.Material).dispose();
    }
    this.flights = [];
    for (const trap of this.traps) { this.renderer.root.remove(trap.group); trap.dispose(); }
    this.traps = [];
    this.actors = [];
    this.freeActors = [];
    this.physics?.dispose();
    this.renderer.dispose();
    this.scoringSystem.dispose();
  }

  // PART2

  tick = (now: number): void => {
    if (!this.running) return;
    const delta = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    this.accumulator += delta;
    while (this.accumulator >= config.physics.fixedStep) {
      this.physics.step();
      this.stepActors(config.physics.fixedStep);
      this.stepCottonFlights(config.physics.fixedStep);
      useGameStore.getState().growCotton(config.physics.fixedStep);
      for (const trap of this.traps) trap.update(config.physics.fixedStep);
      this.accumulator -= config.physics.fixedStep;
    }
    this.renderer.render();
    this.frame = requestAnimationFrame(this.tick);
  };

  private stepActors(delta: number): void {
    useGameStore.getState().cook(delta);
    // Spawning: keeps new goblins entering the yard while pool has room.
    if (this.spawner.update(delta, this.actors.length, config.goblin.pool.maxActive)) this.spawnActor();
    for (let i = this.actors.length - 1; i >= 0; i -= 1) {
      const actor = this.actors[i]!;
      const previousState = actor.fsm.state;
      const toPot = new THREE.Vector3().copy(actor.group.position).setY(0).distanceTo(this.potTarget);
      if (toPot <= config.borshch.threatRadius && (actor.fsm.state === 'Sneak' || actor.fsm.state === 'Grab')) useGameStore.getState().resetCooking();
      const translation = actor.body.translation();
      const radial = Math.hypot(translation.x, translation.z);
      const gone = radial > config.goblin.spawn.despawnRadius || translation.y < config.goblin.spawn.fallResetY;
      // Off the platform or into the void: comic death, never a teleport back.
      if (gone && previousState !== 'Dying') actor.fsm.transition('Dying');
      // Trap collision check for live Sneak/Grab goblins.
      if (actor.fsm.state === 'Sneak' || actor.fsm.state === 'Grab') {
        this.checkTraps(actor);
      }
      actor.fsm.update(delta, toPot, gone);
      if (previousState === 'Dying' && actor.fsm.state === 'Idle') { this.despawnActor(actor, i); continue; }
      this.physics.applyUprightSpring(actor.body, actor.fsm.springEnabled);
      this.updateActor(actor, delta);
    }
  }

  private checkTraps(actor: GoblinActor): void {
    const pos = actor.group.position;
    for (const trap of this.traps) {
      if (!trap.armed || !trap.accepts(actor.fsm)) continue;
      const distance = pos.distanceTo(trap.group.position);
      if (distance <= trap.triggerRadius) {
        trap.trigger(actor.fsm, actor.body);
      }
    }
  }

  selectTrapForPlacement(id: string): boolean {
    if (!canSelectTrapForPlacement(id, useGameStore.getState().unlockedTraps, this.traps.map((trap) => trap.id))) return false;
    this.selectedTrapId = id;
    this.placementIndicator.visible = true;
    return true;
  }
  placeSelectedTrapAt(x: number, z: number): boolean {
    const id = this.selectedTrapId;
    if (!id || !useGameStore.getState().placeItem(id, x, z)) return false;
    this.renderPlacedItem(useGameStore.getState().placed.at(-1)!);
    this.selectedTrapId = null; this.placementIndicator.visible = false;
    return true;
  }
  selectBuildingForPlacement(id: 'fence' | 'decor-tree'): boolean {
    this.selectedTrapId = id; this.placementIndicator.visible = true; return true;
  }
  /** Public placement API for fences, decor and unlocked traps on purchased tiles. */
  placeBuildingAt(id: string, x: number, z: number): boolean {
    if (!useGameStore.getState().placeItem(id, x, z)) return false;
    this.renderPlacedItem(useGameStore.getState().placed.at(-1)!); return true;
  }
  private renderPlacedItem(entry: ReturnType<typeof useGameStore.getState>['placed'][number]): void {
    if (getTrapConfig(entry.itemId)) {
      const trap = createTrap(entry.itemId, this.events);
      const slot = getLandSlots().find(s => s.id === entry.landId);
      if (slot) {
        const center = new THREE.Box3().setFromObject(trap.group).getCenter(new THREE.Vector3());
        for (const child of trap.group.children) { child.position.x -= center.x; child.position.z -= center.z; }
      }
      trap.place(new THREE.Vector3(...entry.position), slot?.rotation ?? 0);
      this.traps.push(trap); this.renderer.root.add(trap.group); return;
    }
    if (entry.itemId !== 'fence' && entry.itemId !== 'decor-tree') return;
    const group = new THREE.Group(); group.position.set(...entry.position);
    const slot = getLandSlots().find(s => s.id === entry.landId); group.rotation.y = slot?.rotation ?? 0;
    const material = this.renderer.toon(entry.itemId === 'fence' ? '#8f6245' : '#4f7f46');
    const add = (geometry: THREE.BufferGeometry, x: number, y: number) => { const mesh = new THREE.Mesh(geometry, material); mesh.position.set(x,y,0); mesh.castShadow = true; group.add(mesh); };
    if (entry.itemId === 'fence') {
      for (const x of [-0.45,0.45]) add(new THREE.BoxGeometry(0.08,0.65,0.08),x,0.325);
      for (const y of [0.2,0.48]) add(new THREE.BoxGeometry(1,0.08,0.06),0,y);
    } else { add(new THREE.CylinderGeometry(0.04,0.06,0.45,5),0,0.225); add(new THREE.ConeGeometry(0.28,0.55,6),0,0.58); }
    this.placedBuildings.push(group); this.renderer.root.add(group);
  }
  private createPlacementIndicator(): void {
    this.placementIndicatorRing = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 32), new THREE.MeshBasicMaterial({ color: '#74a957' }));
    this.placementIndicatorRing.rotation.x = -Math.PI / 2;
    this.placementIndicator.add(this.placementIndicatorRing);
    this.placementIndicator.visible = false;
    this.renderer.root.add(this.placementIndicator);
  }

  private spawnActor(kind: EnemyKind | 'bat' = this.nextSpawnKind()): void {
    const freeIndex = this.freeActors.findIndex((candidate) => candidate.kind === kind);
    const actor = freeIndex >= 0 ? this.freeActors.splice(freeIndex, 1)[0]! : this.createActor(kind);
    actor.kind = kind;
    const rng = Math.random.bind(Math);
    const position = getEnemyBasePosition(kind === 'bat' ? 'goblin' : kind);
    const spawnX = position.x + (rng() - 0.5) * 0.22;
    const spawnZ = position.z + (rng() - 0.5) * 0.22;
    const height = kind === 'orc' ? config.orc.height : config.goblin.height;
    actor.body.setGravityScale(kind === 'bat' ? 0 : 1, true);
    actor.body.setTranslation({ x: spawnX, y: kind === 'bat' ? config.bat.flightHeight : position.y + height / 2 + 0.05, z: spawnZ }, true);
    actor.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    actor.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    actor.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    actor.fsm.reset('Idle');
    const tuning = actor.kind === 'bat' ? config.bat : actor.kind === 'orc' ? config.orc : config.goblin;
    actor.speed = tuning.speed * (1 - tuning.speedJitter / 2 + rng() * tuning.speedJitter);
    actor.group.visible = true;
    actor.stars.visible = false;
    actor.walkPhase = 0;
    actor.squash.scale.set(1, 1, 1);
    actor.squash.rotation.set(0, 0, 0);
    this.actors.push(actor);
    this.events.emit('goblin:state', { state: 'spawn' });
  }

  private despawnActor(actor: GoblinActor, index: number): void {
    this.actors.splice(index, 1);
    this.freeActors.push(actor);
    actor.group.visible = false; actor.stars.visible = false;
  }

  private createActor(kind: EnemyKind | 'bat'): GoblinActor {
    if (!this.visuals) this.buildSharedVisuals();
    const visuals = this.visuals!;
    const isOrc = kind === 'orc';
    const group = new THREE.Group();
    const squash = new THREE.Group();
    group.add(squash);
    const body = new THREE.Mesh(kind === 'bat' ? new THREE.CylinderGeometry(config.goblin.radius, config.goblin.radius, config.goblin.height, 12) : isOrc ? visuals.orcBody : visuals.capsule, kind === 'bat' ? this.renderer.toon(config.bat.color) : isOrc ? visuals.orcMat : visuals.bodyMat);
    body.position.y = (isOrc ? config.orc.height : config.goblin.height) / 2;
    body.castShadow = true;
    squash.add(body);
    if (kind === 'bat') body.scale.setScalar(0.6);
    if (isOrc) {
      for (const tuskX of [-0.11, 0.11]) {
        const tusk = new THREE.Mesh(visuals.tusk, visuals.tuskMat);
        tusk.position.set(tuskX, 0.42, 0.25);
        tusk.rotation.x = Math.PI;
        squash.add(tusk);
      }
    }
    for (const eyeX of kind === 'bat' ? [] : [-0.12, 0.12]) {
      const eye = new THREE.Mesh(visuals.eye, visuals.eyeMat);
      eye.position.set(eyeX, isOrc ? 0.78 : 0.76, 0.22);
      squash.add(eye);
    }
    const stars = new THREE.Group();
    stars.position.y = config.goblin.visuals.starHeight;
    for (let i = 0; i < 3; i += 1) {
      const star = new THREE.Mesh(visuals.star, visuals.starMat);
      star.position.set((i - 1) * 0.32, 0.15 + Math.abs(i - 1) * 0.1, 0);
      stars.add(star);
    }
    stars.visible = false;
    this.renderer.root.add(group, stars);
    this.renderer.scene.userData.addOutlined(body);
    const fsm = kind === 'bat' ? new BatFSM(Date.now(), this.events) : isOrc ? new OrcFSM(Date.now() % 100000 + this.actors.length * 13, this.events) : new GoblinFSM(Date.now() % 100000 + this.actors.length * 13, this.events);
    const rapierBody = this.physics.createGoblinBody({ x: 0, y: config.goblin.height / 2 + 0.05, z: this.spawnEdgeZ });
    const actor: GoblinActor = { kind, fsm, body: rapierBody, group, squash, stars, walkPhase: 0, speed: isOrc ? config.orc.speed : config.goblin.speed };
    this.events.emit('goblin:state', { state: 'spawn' });
    return actor;
  }

  // PART4

  private buildSharedVisuals(): void {
    const g = config.goblin;
    this.visuals = {
      capsule: new THREE.CapsuleGeometry(g.radius, g.height - g.radius * 2, 3, 6),
      orcBody: new THREE.CapsuleGeometry(g.radius * 1.08, config.orc.height - g.radius * 2, 3, 6),
      tusk: new THREE.ConeGeometry(0.045, 0.16, 5),
      eye: new THREE.SphereGeometry(0.045, 5, 4),
      star: new THREE.OctahedronGeometry(0.14),
      bodyMat: this.renderer.toon('#77a85a'),
      orcMat: this.renderer.toon(config.orc.color),
      tuskMat: this.renderer.toon('#f5e3b0'),
      eyeMat: this.renderer.toon('#fff5df'),
      starMat: this.renderer.toon('#ffe98a'),
    };
  }

  // PART5

  private updateActor(actor: GoblinActor, delta: number): void {
    const { fsm, body, group, squash, stars } = actor;
    const state = fsm.state;
    const yaw = getActorFacingYaw(state, group.position.x, group.position.z, this.potTarget.x, this.potTarget.z);
    if (yaw !== null) squash.rotation.y = yaw;
    if (actor.kind === 'bat') {
      body.setGravityScale(state === 'Dying' ? 1 : 0, true);
      if (state !== 'Dying') body.setLinvel({ ...body.linvel(), y: (config.bat.flightHeight - body.translation().y) * 4 }, true);
    }
    const linear = body.linvel();
    if (state === 'Sneak' || state === 'Grab') {
      // Constant slow walk toward the pot (no damp-speed chase) with per-goblin pace.
      const dirX = this.potTarget.x - group.position.x;
      const dirZ = this.potTarget.z - group.position.z;
      const length = Math.hypot(dirX, dirZ) || 1;
      body.setLinvel({ x: (dirX / length) * actor.speed, y: linear.y, z: (dirZ / length) * actor.speed }, true);
      group.rotation.y = Math.PI;
    } else if (state === 'Flee') {
      body.setLinvel({ x: 0, y: linear.y, z: -actor.speed * config.goblin.fleeSpeedMultiplier }, true);
      group.rotation.y = 0;
    } else if (state === 'Stunned') {
      body.setLinvel({ x: 0, y: linear.y, z: 0 }, true);
    } else if (state === 'Recover') {
      body.setLinvel(
        { x: 0, y: linear.y, z: actor.speed * config.goblin.slowSpeedMultiplier },
        true,
      );
    }
    // 'Dying' skips the walking controllers above: free fall keeps its momentum.
    const translation = body.translation();
    const rotation = body.rotation();
    group.position.set(translation.x, translation.y - 0.5, translation.z);
    group.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    if (state === 'Dying') {
      // Comic death: tumble head over heels, shrink out, dizzy stars.
      squash.rotation.x += delta * config.goblin.deathSpin;
      const k = Math.max(0, 1 - fsm.elapsed / Math.max(config.goblin.dyingSeconds, 0.001));
      squash.scale.setScalar(Math.max(0.04, k));
      stars.visible = true;
    } else {
      actor.walkPhase += delta * (state === 'Flee' ? actor.speed * 26 : actor.speed * 20);
      squash.position.y = (state === 'Sneak' || state === 'Grab' || state === 'Flee') ? Math.abs(Math.sin(actor.walkPhase)) * 0.035 : 0;
      const flop = state === 'Stunned' ? Math.sin(fsm.elapsed * 15) * 0.42 : 0;
      squash.rotation.z = flop;
      const pulse = state === 'Grab' ? 1 + Math.sin(fsm.elapsed * 18) * 0.08 : 1;
      squash.scale.set(1 / pulse, pulse, 1 / pulse);
      stars.visible = state === 'Stunned';
    }
    stars.position.x = group.position.x;
    stars.position.z = group.position.z;
    stars.rotation.y += delta * config.goblin.visuals.starSpinSpeed;
  }

  // PART6

  private bindTap(): void {
    const canvas = this.renderer.renderer.domElement;
    canvas.style.touchAction = 'none';
    const cancel = (event: PointerEvent) => {
      if (!this.decorationDrag) this.pointerDown = null;
      if (this.decorationDrag?.pointerId === event.pointerId) {
        this.decorationDrag.item.position.copy(this.decorationDrag.start);
        this.decorationDrag = null;
        this.pointerDown = null;
        if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture?.(event.pointerId);
      }
    };
    canvas.addEventListener('pointercancel', cancel);
    canvas.addEventListener('lostpointercapture', cancel);
    canvas.addEventListener('pointerdown', (event) => {
      if (this.decorationDrag) { event.stopImmediatePropagation(); return; }
      if ((event.pointerType === 'mouse' && (event.button !== 0 || event.shiftKey)) || event.isPrimary === false) return;
      if (!this.running) return;
      this.pointerDown = { x: event.clientX, y: event.clientY, t: performance.now() };
      this.setPointerRay(event);
      for (const [landId, tile] of this.selectedTrapId ? [] : this.landDecorations) {
        if (!tile.visible || !useGameStore.getState().purchasedLand.includes(landId)) continue;
        tile.updateWorldMatrix(true, true);
        const hit = this.raycaster.intersectObjects(tile.children, true)[0];
        if (!hit) continue;
        let item = hit.object;
        while (item.parent && item.parent !== tile) item = item.parent;
        const point = this.decorationPoint(tile);
        if (!point) continue;
        this.decorationDrag = { pointerId: event.pointerId, item, landId, itemId: item.name,
          offset: item.position.clone().sub(point), start: item.position.clone(), moved: false };
        canvas.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        event.stopImmediatePropagation();
        break;
      }
    }, true);
    canvas.addEventListener('pointermove', (event) => {
      const drag = this.decorationDrag, down = this.pointerDown;
      if (!drag) return;
      event.stopImmediatePropagation();
      if (!down || drag.pointerId !== event.pointerId) return;
      if (!useGameStore.getState().purchasedLand.includes(drag.landId)) { cancel(event); return; }
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8) drag.moved = true;
      if (!drag.moved) return;
      this.setPointerRay(event);
      const point = this.decorationPoint(drag.item.parent!);
      if (!point) return;
      point.add(drag.offset);
      const limit = decorationLimit(drag.itemId)!;
      drag.item.position.x = THREE.MathUtils.clamp(point.x, -limit, limit);
      drag.item.position.z = THREE.MathUtils.clamp(point.z, -limit, limit);
      event.preventDefault();
    }, true);
    canvas.addEventListener('pointerup', (event) => {
      const drag = this.decorationDrag;
      if (drag) {
        event.stopImmediatePropagation();
        if (drag.pointerId !== event.pointerId) return;
        this.decorationDrag = null;
        this.pointerDown = null;
        if (drag.moved && !useGameStore.getState().moveDecoration(drag.landId, drag.itemId, drag.item.position.x, drag.item.position.z)) drag.item.position.copy(drag.start);
        if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }
      const down = this.pointerDown;
      this.pointerDown = null;
      if (!down || !this.running || event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
      const dist = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      if (dist > 8 || performance.now() - down.t > 350) return;
      const rect = canvas.getBoundingClientRect();
      const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.renderer.camera);
      const point = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -getFieldTileTopY()), new THREE.Vector3());
      if (this.selectedTrapId) {
        const surfaces = [...this.landPlatforms.values()].filter(mesh => mesh.visible);
        const hit = this.raycaster.intersectObjects(surfaces, false)[0];
        if (hit) this.placeSelectedTrapAt(hit.point.x, hit.point.z);
        else { const ground = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0), 0), new THREE.Vector3()); if (ground) this.placeSelectedTrapAt(ground.x, ground.z); }
        return;
      }
      if (point && Math.abs(point.x) <= config.yard.field.tileSize / 2 && Math.abs(point.z) <= config.yard.field.tileSize / 2 && canHarvestCotton(useGameStore.getState().cottonGrowth)) { this.launchCotton(); return; }
      this.tapGoblin(nx, ny);
    }, true);
  }

  private setPointerRay(event: PointerEvent): void {
    const rect = this.renderer.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    ), this.renderer.camera);
  }

  private decorationPoint(tile: THREE.Object3D): THREE.Vector3 | null {
    const origin = tile.getWorldPosition(new THREE.Vector3());
    const point = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -origin.y), new THREE.Vector3());
    return point ? tile.worldToLocal(point) : null;
  }

  private tapGoblin(nx: number, ny: number): void {
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.renderer.camera);
    const maxDist = config.goblin.tap.maxPickDistance;
    let best: { actor: GoblinActor; score: number } | null = null;
    for (const actor of this.actors) {
      if (!actor.group.visible) continue;
      if (actor.fsm.state !== 'Sneak' && actor.fsm.state !== 'Grab') continue;
      const distance = this.raycaster.ray.distanceToPoint(actor.group.position);
      if (distance > maxDist) continue;
      const center = this.raycaster.ray.closestPointToPoint(actor.group.position.clone(), new THREE.Vector3());
      const score = center.distanceTo(this.raycaster.ray.origin);
      if (!best || score < best.score) best = { actor, score };
    }
    if (!best) return;
    best.actor.fsm.hit();
    const hitImpulse = config.goblin.hitImpulse;
    if (best.actor.fsm.state === 'Dying') {
      best.actor.body.applyImpulse(getCursorKnockbackImpulse(best.actor.group.position, this.raycaster.ray.origin, hitImpulse), true);
    }
    this.events.emit('goblin:tap', { reward: config.economy.earnPerTap });
  }

  private nextSpawnKind(): EnemyKind | 'bat' {
    const index = this.spawnSequence++;
    return (index + 1) % config.bat.spawnEvery === 0 ? 'bat' : getEnemySpawnKind(index);
  }
  spawnBat(): void { this.spawnActor('bat'); }
  launchCotton(): boolean {
    const base = nearestActiveBase(this.bases, new THREE.Vector3(0, getFieldTileTopY(), 0), useGameStore.getState().attacks);
    if (!base || !useGameStore.getState().launchCotton(base.id)) return false;
    this.createCottonFlight(base);
    this.events.emit('cotton:launched', { baseId: base.id, side: base.side });
    return true;
  }
  private createCottonFlight(base: EnemyBase): void {
    base.targeted = true;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), this.renderer.toon('#fff5df'));
    const origin = new THREE.Vector3(0, getFieldTileTopY() + 0.5, 0);
    mesh.position.copy(origin); this.renderer.root.add(mesh);
    this.flights.push({ base, mesh, origin, elapsed: 0 });
  }
  private stepCottonFlights(delta: number): void {
    // Reveal the next distinct slot while the destroyed slot remains land.
    for (const [base, elapsed] of this.baseReveals) {
      if (base.destroyed) { this.baseReveals.delete(base); continue; }
      const nextElapsed = elapsed + delta;
      const scale = THREE.MathUtils.clamp((nextElapsed - 0.35) / 0.35, 0, 1);
      base.group.scale.setScalar(scale);
      base.group.visible = scale > 0;
      if (scale === 1) this.baseReveals.delete(base);
      else this.baseReveals.set(base, nextElapsed);
    }
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const flight = this.flights[i]!;
      flight.elapsed += delta;
      const t = Math.min(1, flight.elapsed / config.cottonAttack.flightSeconds);
      flight.mesh.position.lerpVectors(flight.origin, flight.base.group.position, t);
      flight.mesh.position.y += Math.sin(Math.PI * t) * config.cottonAttack.arcHeight;
      if (t < 1) continue;
      if (useGameStore.getState().destroyBase(flight.base.id)) {
        flight.base.destroy();
        const next = this.bases.find((base) => base.id === `${flight.base.side}-${Number(flight.base.id.split('-')[1]) + 1}`);
        if (next) { next.active = true; next.group.visible = false; next.group.scale.setScalar(0); this.baseReveals.set(next, 0); }
        this.events.emit('base:destroyed', { baseId: flight.base.id, side: flight.base.side });
        this.events.emit('land:unlocked', { landId: flight.base.id });
      }
      this.renderer.root.remove(flight.mesh); flight.mesh.geometry.dispose();
      (flight.mesh.material as THREE.Material).dispose(); this.flights.splice(i, 1);
    }
  }

  spawnGoblin(): void {
    this.spawnActor('goblin');
  }

  spawnOrc(): void {
    this.spawnActor('orc');
  }

  killAllGoblins(): number {
    let count = 0;
    for (const actor of this.actors) {
      if (!actor.group.visible || actor.fsm.state === 'Dying') continue;
      actor.fsm.transition('Dying');
      count += 1;
    }
    return count;
  }

  private createDiorama(): void {
    const { scene, root } = this.renderer;
    this.bases = [];
    const progress = useGameStore.getState();
    for (const side of ['goblin', 'orc'] as const) {
      for (let index = 1; index <= Math.min(10, config.cottonAttack.maxPerSide); index++) {
        const position = getLandSlots().find(slot => slot.id === `${side}-${index}`)!;
        const base = new EnemyBase(`${side}-${index}`, side === 'goblin' ? '#77a85a' : config.orc.color, position.x, position.z, (color) => this.renderer.toon(color), position.y);
        base.active = index === 1 || progress.destroyedBases.includes(`${side}-${index - 1}`);
        if (progress.destroyedBases.includes(base.id)) base.destroy();
        base.group.visible = base.active && !base.destroyed;
        this.bases.push(base);
        root.add(base.group);
        if (progress.pendingBases.includes(base.id)) this.createCottonFlight(base);
      }
    }
    this.createLandPlatforms();
    this.createLandDecorations();
    for (const entry of progress.placed) this.renderPlacedItem(entry);
    const fieldTiles = getFieldTilePositions();
    const tileGeometry = new THREE.BoxGeometry(config.yard.field.tileSize, FIELD_TILE_THICKNESS, config.yard.field.tileSize);
    const tileMaterial = this.renderer.toon('#9b704c');
    const tileCenterY = getFieldTileTopY() - FIELD_TILE_THICKNESS / 2;
    for (const x of fieldTiles) {
      const tile = new THREE.Mesh(tileGeometry, tileMaterial);
      tile.position.set(x, tileCenterY, 0);
      tile.receiveShadow = true;
      root.add(tile);
    }
    const ground = new THREE.Mesh(new THREE.CylinderGeometry(config.yard.size / 2, config.yard.size / 2, GROUND_SLAB_HEIGHT, 8), this.renderer.toon('#84a567'));
    ground.position.y = GROUND_CENTER_Y;
    ground.receiveShadow = true;
    root.add(ground);
    const side = new THREE.Mesh(new THREE.CylinderGeometry(config.yard.size / 2, config.yard.size / 2, 0.4, 8, 1, true), this.renderer.toon('#8f6245'));
    side.position.y = GROUND_CENTER_Y - GROUND_SLAB_HEIGHT / 2 - 0.18;
    root.add(side);
    for (const island of config.islands) {
      const layout = getIslandLayout(island.kind as EnemyKind);
      const { x, z } = layout;
      const islandHalf = island.height / 2;
      const slab = new THREE.Mesh(new THREE.CylinderGeometry(island.radius, island.radius, island.height, island.segments), this.renderer.toon('#84a567'));
      slab.name = `island-${island.kind}`;
      slab.position.set(x, layout.topY - islandHalf, z);
      slab.rotation.y = layout.meshRotation;
      slab.castShadow = true;
      slab.receiveShadow = true;
      root.add(slab);
      scene.userData.addOutlined(slab);
      const islandSide = new THREE.Mesh(new THREE.CylinderGeometry(island.radius, island.radius, 0.4, island.segments, 1, true), this.renderer.toon('#8f6245'));
      islandSide.position.set(x, layout.topY - island.height - 0.18, z);
      islandSide.rotation.y = layout.meshRotation;
      root.add(islandSide);
    }
    this.createCottonGarden();
    const pot = new THREE.Group();
    pot.position.set(config.yard.potPosition[0], config.yard.potPosition[1], config.yard.potPosition[2]);
    const potBody = new THREE.Mesh(new THREE.CylinderGeometry(0.54, 0.43, 0.63, 8), this.renderer.toon('#c75e42'));
    potBody.castShadow = true;
    pot.add(potBody);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.53, 0.07, 5, 10), this.renderer.toon('#e48a4c'));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.32;
    pot.add(rim);
    const soup = new THREE.Mesh(new THREE.CircleGeometry(0.46, 10), this.renderer.toon('#a94835'));
    soup.rotation.x = -Math.PI / 2;
    soup.position.y = 0.29;
    pot.add(soup);
    root.add(pot);
    const sprigMaterial = this.renderer.toon('#668c4f');
    for (let i = 0; i < 7; i += 1) {
      const x = Math.cos(i * Math.PI * 2 / 7) * 2.35;
      const z = Math.sin(i * Math.PI * 2 / 7) * 2.35;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.06, 0.62, 4), sprigMaterial);
      stem.position.set(x, 0.28, z);
      stem.rotation.z = (i % 2 ? 1 : -1) * 0.17;
      stem.castShadow = true;
      root.add(stem);
    }
    scene.userData.addOutlined(ground);
    scene.userData.addOutlined(potBody);
  }

  private createLandPlatforms(): void {
    for (const slot of getLandSlots()) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(LAND_SIZE, 0.62, LAND_SIZE), this.renderer.toon('#80644b'));
      mesh.name = `land-${slot.id}`; mesh.position.set(slot.x, slot.y - 0.31, slot.z); mesh.rotation.y = slot.rotation;
      mesh.receiveShadow = true; mesh.visible = useGameStore.getState().destroyedBases.includes(slot.id);
      this.landPlatforms.set(slot.id, mesh); this.renderer.root.add(mesh);
    }
    const update = () => {
      const state = useGameStore.getState();
      for (const [id, mesh] of this.landPlatforms) {
        const index = Number(id.split('-')[1]), side = id.split('-')[0];
        const destroyed = state.destroyedBases.includes(id);
        mesh.visible = destroyed || index === 1 || state.destroyedBases.includes(`${side}-${index - 1}`);
        mesh.userData.owner = destroyed ? 'land' : 'enemy';
        (mesh.material as THREE.MeshToonMaterial).color.set(destroyed ? '#84a567' : '#80644b');
      }
    };
    update();
    this.landPlatformsUnsubscribe = useGameStore.subscribe(update);
  }

  private createLandDecorations(): void {
    const purchased = new Set(useGameStore.getState().purchasedLand);
    const treeMaterial = this.renderer.toon('#4f7f46');
    const trunkMaterial = this.renderer.toon('#8f6245');
    const flowerMaterials = [this.renderer.toon('#f6c85f'), this.renderer.toon('#e87979'), this.renderer.toon('#b49ae8')];
    for (const base of this.bases) {
      const decoration = new THREE.Group();
      decoration.name = `decor-${base.id}`;
      decoration.position.copy(base.group.position);
      decoration.rotation.y = getLandSlots().find(slot => slot.id === base.id)!.rotation;
      const offsets = [[-0.65, -0.35], [0.55, -0.2], [-0.15, 0.55]] as const;
      offsets.forEach(([x, z], index) => {
        const tree = new THREE.Group();
        tree.name = `tree-${index}`;
        tree.position.set(x, 0, z);
        decoration.add(tree);
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.45, 5), trunkMaterial);
        stem.position.set(0, 0.22, 0);
        stem.castShadow = true;
        tree.add(stem);
        const crown = new THREE.Mesh(new THREE.SphereGeometry(0.22 + index * 0.03, 6, 5), treeMaterial);
        crown.position.set(stem.position.x, stem.position.y + 0.28, stem.position.z);
        crown.castShadow = true;
        tree.add(crown);
      });
      for (let index = 0; index < 5; index += 1) {
        const flower = new THREE.Mesh(new THREE.SphereGeometry(0.06, 5, 4), flowerMaterials[index % flowerMaterials.length]);
        const angle = index * Math.PI * 2 / 5;
        flower.name = `flower-${index}`;
        flower.position.set(Math.cos(angle) * 0.9, 0.07, Math.sin(angle) * 0.9);
        decoration.add(flower);
      }
      for (const p of useGameStore.getState().decorationPositions.filter((p) => p.landId === base.id)) {
        const item = decoration.getObjectByName(p.itemId);
        if (item) { item.position.x = p.x; item.position.z = p.z; }
      }
      decoration.visible = purchased.has(base.id);
      this.renderer.root.add(decoration);
      this.landDecorations.set(base.id, decoration);
    }
    this.landDecorationsUnsubscribe = useGameStore.subscribe((state) => {
      const purchased = new Set(state.purchasedLand);
      for (const [id, decoration] of this.landDecorations) decoration.visible = purchased.has(id);
    });
  }

  private createCottonGarden(): void {
    const root = this.renderer.root;
    const garden = new THREE.Group();
    garden.name = 'cotton-garden';
    const { tileSize } = config.yard.field;
    const count = 7;
    const plants: THREE.Group[] = [];
    const stemMaterial = this.renderer.toon('#578341');
    const leafMaterial = this.renderer.toon('#79a64d');
    const cottonMaterial = this.renderer.toon('#fff5db');
    const cottonGeo = new THREE.SphereGeometry(0.09, 6, 5);
    for (let i = 0; i < count; i += 1) {
      const plant = new THREE.Group();
      const angle = i * Math.PI * 2 / count;
      plant.position.set(Math.cos(angle) * tileSize * 0.27, getFieldTileTopY(), Math.sin(angle) * tileSize * 0.27);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.028, 0.28, 5), stemMaterial);
      stem.position.y = 0.14;
      plant.add(stem);
      for (const side of [-1, 1]) {
        const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.08, 5, 4), leafMaterial);
        leaf.scale.set(1.3, 0.45, 0.7);
        leaf.position.set(side * 0.07, 0.12, 0);
        leaf.castShadow = true;
        plant.add(leaf);
      }
      const boll = new THREE.Group();
      boll.position.y = 0.29;
      for (let petal = 0; petal < 3; petal += 1) {
        const cotton = new THREE.Mesh(cottonGeo, cottonMaterial);
        const petalAngle = petal * Math.PI * 2 / 3;
        cotton.position.set(Math.cos(petalAngle) * 0.055, petal % 2 * 0.035, Math.sin(petalAngle) * 0.055);
        cotton.castShadow = true;
        boll.add(cotton);
      }
      plant.add(boll);
      plant.userData.boll = boll;
      plants.push(plant);
      garden.add(plant);
    }
    root.add(garden);
    const update = () => {
      const growth = useGameStore.getState().cottonGrowth;
      for (const plant of plants) {
        plant.scale.setScalar(0.25 + growth * 0.75);
        const boll = plant.userData.boll as THREE.Group;
        boll.visible = growth >= 0.7;
      }
    };
    update();
    useGameStore.subscribe(update);
  }
}
