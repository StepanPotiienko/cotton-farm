import RAPIER from '@dimforge/rapier3d-compat';
import config from '../state/config/game.json';
import { getIslandLayout, getLandSlots, LAND_SIZE } from './LandLayout';
export class Physics {
  readonly world: RAPIER.World;
  private landColliders = new Map<string, RAPIER.Collider>();
  private constructor(world: RAPIER.World) { this.world = world; }
  static async create(): Promise<Physics> {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: config.physics.gravity, z: 0 });
    world.integrationParameters.numSolverIterations = config.physics.solverIterations;
    return new Physics(world);
  }
  step(): void { this.world.timestep = config.physics.fixedStep; this.world.step(); }
  createGoblinBody(position: { x: number; y: number; z: number }): RAPIER.RigidBody {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(position.x, position.y, position.z)
        .setLinearDamping(1.4).setAngularDamping(2.2),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.capsule(config.goblin.height / 2 - config.goblin.radius, config.goblin.radius)
        .setFriction(0.8).setRestitution(0.05),
      body,
    );
    return body;
  }
  applyUprightSpring(body: RAPIER.RigidBody, enabled: boolean): void {
    if (!enabled) return;
    // Kinematic uprighting: slerp the body quaternion toward upright every fixed step.
    // The previous torque spring (and even a sign-fixed one) resonated with the walking
    // setLinvel controller and blew angvel up by 1e18 in ~30 steps -> solver NaN.
    // A direct blend is unconditionally stable and keeps comedy flops when disabled (Stunned).
    const rotation = body.rotation();
    const w = rotation.w, x = rotation.x, y = rotation.y, z = rotation.z;
    const blend = Math.min(1, config.physics.fixedStep * 12);
    const qw = w + (1 - w) * blend;
    const qx = x + (0 - x) * blend;
    const qy = y + (0 - y) * blend;
    const qz = z + (0 - z) * blend;
    const norm = Math.hypot(qw, qx, qy, qz) || 1;
    body.setRotation({ w: qw / norm, x: qx / norm, y: qy / norm, z: qz / norm }, true);
    const angular = body.angvel();
    body.setAngvel({ x: angular.x * 0.5, y: 0, z: angular.z * 0.5 }, true);
  }
  floor(): void {
    // Round platform collider: Rapier order is (halfHeight, radius)!
    const half = config.yard.floorHalfHeight;
    this.world.createCollider(
      RAPIER.ColliderDesc.cylinder(half, config.yard.size / 2).setTranslation(0, -half, 0),
    );
    // Convex prisms match the rotated polygon meshes, including their joining edges.
    for (const island of config.islands) {
      const layout = getIslandLayout(island.kind as 'goblin' | 'orc');
      const islandHalf = layout.height / 2;
      const vertices: number[] = [];
      for (const y of [-islandHalf, islandHalf]) {
        for (let i = 0; i < layout.segments; i++) {
          const angle = i * Math.PI * 2 / layout.segments + layout.meshRotation;
          vertices.push(layout.radius * Math.sin(angle), y, layout.radius * Math.cos(angle));
        }
      }
      this.world.createCollider(
        RAPIER.ColliderDesc.convexHull(new Float32Array(vertices))!
          .setTranslation(layout.x, layout.topY - islandHalf, layout.z),
      );
    }
    // Rapier 0.14: the scene query pipeline must be refreshed after collider
    // changes, otherwise static castRay queries miss the freshly added floor
    // colliders until the first step().
    this.world.updateSceneQueries();
  }
  /** Only visible active/destroyed slabs support bodies; future hidden slots have no collider. */
  syncLandSupport(destroyedBases: string[]): void {
    for (const slot of getLandSlots()) {
      const index = Number(slot.id.split('-')[1]);
      const visible = index === 1 || destroyedBases.includes(slot.id) || destroyedBases.includes(`${slot.side}-${index - 1}`);
      const existing = this.landColliders.get(slot.id);
      if (visible && !existing) {
        const rotation = { x: 0, y: Math.sin(slot.rotation / 2), z: 0, w: Math.cos(slot.rotation / 2) };
        const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(LAND_SIZE / 2, 0.31, LAND_SIZE / 2)
          .setTranslation(slot.x, slot.y - 0.31, slot.z).setRotation(rotation));
        this.landColliders.set(slot.id, collider);
      } else if (!visible && existing) {
        this.world.removeCollider(existing, true); this.landColliders.delete(slot.id);
      }
    }
    this.world.updateSceneQueries();
  }
  dispose(): void { this.world.free(); }
}
