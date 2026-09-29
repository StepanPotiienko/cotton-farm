import RAPIER from '@dimforge/rapier3d-compat';
import config from '../state/config/game.json';
export class Physics {
  readonly world: RAPIER.World;
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
  }
  dispose(): void { this.world.free(); }
}
