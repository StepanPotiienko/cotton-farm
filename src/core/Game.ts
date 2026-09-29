import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { EventBus, type GameEvents } from './Events';
import { Physics } from './Physics';
import { createRng } from './random';
import { Renderer } from './Renderer';
import { GoblinFSM, GoblinSpawner, OrcFSM } from '../entities/Goblin';
import { createTrap, type Trap } from '../entities/Trap';
import { ScoringSystem } from '../systems/ScoringSystem';
import { ShopSystem } from '../systems/ShopSystem';
import { useGameStore } from '../state/store';
import { setShopSystem } from '../ui/hud';
import config from '../state/config/game.json';

interface GoblinActor {
  kind: 'goblin' | 'orc';
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
  private spawner: GoblinSpawner;
  private raycaster = new THREE.Raycaster();
  private pointerDown: { x: number; y: number; t: number } | null = null;
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
    setShopSystem(this.shopSystem);
    this.createDiorama();
    for (const trapId of config.yard.startingTrapIds) this.placeTrap(trapId);
    this.events.on('shop:purchased', ({ itemId }) => this.placeTrap(itemId));
    this.bindTap();
  }

  async start(): Promise<void> {
    this.physics = await Physics.create();
    this.physics.floor();
    for (let i = 0; i < config.goblin.pool.initialSpawnCount; i += 1) this.spawnActor();
    this.running = true;
    this.lastTime = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
    for (const actor of this.actors) this.renderer.root.remove(actor.group, actor.stars);
    for (const trap of this.traps) this.renderer.root.remove(trap.group);
    this.traps.forEach((trap) => trap.dispose());
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
      if (!trap.armed) continue;
      const distance = pos.distanceTo(trap.group.position);
      if (distance <= trap.triggerRadius) {
        trap.trigger(actor.fsm, actor.body);
      }
    }
  }

  private placeTrap(id: string): void {
    if (this.traps.some((trap) => trap.id === id)) return;
    const trap = createTrap(id, this.events);
    const placements: Record<string, [number, number, number, number]> = {
      rake: [0, 0, config.yard.potPosition[2] + 1.1, Math.PI],
      haystack: [-2.2, 0, 0.4, -Math.PI / 2],
      pan: [2.2, 0, 0.4, Math.PI / 2],
    };
    const [x, y, z, rotation] = placements[id] ?? [0, 0, 0, 0];
    trap.place(new THREE.Vector3(x, y, z), rotation);
    this.traps.push(trap);
    this.renderer.root.add(trap.group);
  }

  private spawnActor(kind: 'goblin' | 'orc' = this.spawnSequence++ % 2 === 1 ? 'orc' : 'goblin'): void {
    const freeIndex = this.freeActors.findIndex((candidate) => candidate.kind === kind);
    const actor = freeIndex >= 0 ? this.freeActors.splice(freeIndex, 1)[0]! : this.createActor(kind);
    actor.kind = kind;
    const rng = Math.random.bind(Math);
    // Spawn ON the platform: random point on a ring near the south edge (inside floor radius).
    const angle = rng() * Math.PI * 2;
    const radius = config.goblin.spawn.spawnRadius * (0.9 + rng() * 0.1);
    const spawnX = Math.cos(angle) * radius;
    const spawnZ = Math.sin(angle) * radius;
    actor.body.setTranslation({ x: spawnX, y: config.goblin.height / 2 + 0.05, z: spawnZ }, true);
    actor.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    actor.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    actor.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    actor.fsm.reset('Idle');
    const tuning = actor.kind === 'orc' ? config.orc : config.goblin;
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

  private createActor(kind: 'goblin' | 'orc'): GoblinActor {
    if (!this.visuals) this.buildSharedVisuals();
    const visuals = this.visuals!;
    const isOrc = kind === 'orc';
    const group = new THREE.Group();
    const squash = new THREE.Group();
    group.add(squash);
    const body = new THREE.Mesh(isOrc ? visuals.orcBody : visuals.capsule, isOrc ? visuals.orcMat : visuals.bodyMat);
    body.position.y = (isOrc ? config.orc.height : config.goblin.height) / 2;
    body.castShadow = true;
    squash.add(body);
    if (isOrc) {
      for (const tuskX of [-0.11, 0.11]) {
        const tusk = new THREE.Mesh(visuals.tusk, visuals.tuskMat);
        tusk.position.set(tuskX, 0.42, 0.25);
        tusk.rotation.x = Math.PI;
        squash.add(tusk);
      }
    }
    for (const eyeX of [-0.12, 0.12]) {
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
    const fsm = isOrc ? new OrcFSM(Date.now() % 100000 + this.actors.length * 13, this.events) : new GoblinFSM(Date.now() % 100000 + this.actors.length * 13, this.events);
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
    canvas.addEventListener('pointerdown', (event) => {
      this.pointerDown = { x: event.clientX, y: event.clientY, t: performance.now() };
    });
    canvas.addEventListener('pointerup', (event) => {
      const down = this.pointerDown;
      this.pointerDown = null;
      if (!down || !this.running) return;
      const dist = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      if (dist > 8 || performance.now() - down.t > 350) return;
      const rect = canvas.getBoundingClientRect();
      const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      this.tapGoblin(nx, ny);
    });
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
    const ground = new THREE.Mesh(new THREE.CylinderGeometry(config.yard.size / 2, config.yard.size / 2, 0.62, 8), this.renderer.toon('#84a567'));
    ground.position.y = -0.34;
    ground.receiveShadow = true;
    root.add(ground);
    const side = new THREE.Mesh(new THREE.CylinderGeometry(config.yard.size / 2, config.yard.size / 2, 0.4, 8, 1, true), this.renderer.toon('#8f6245'));
    side.position.y = -0.83;
    root.add(side);
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
}
