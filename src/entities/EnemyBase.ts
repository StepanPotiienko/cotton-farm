import * as THREE from 'three';
import type { BaseSide } from '../state/store';

/** Small, self-contained base landmark for an enemy faction. */
export class EnemyBase {
  destroyed = false;
  targeted = false;
  active = true;
  get id(): string { return this.group.name; }
  get side(): BaseSide { return this.id.startsWith('orc') ? 'orc' : 'goblin'; }
  destroy(): void { this.destroyed = true; this.active = false; this.targeted = false; this.group.visible = false; }
  readonly group = new THREE.Group();
  private readonly geometry: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(name: string, color: THREE.ColorRepresentation, x: number, z: number, toon: (color: THREE.ColorRepresentation) => THREE.MeshToonMaterial, y = 0) {
    this.group.name = name.includes('-') ? name : `${name}-1`;
    this.group.position.set(x, y, z);
    const material = toon(color);
    this.materials.push(material);
    const addMesh = (geo: THREE.BufferGeometry, y: number, scaleX = 1, scaleZ = 1) => {
      this.geometry.push(geo);
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.y = y;
      mesh.scale.set(scaleX, 1, scaleZ);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    const mound = addMesh(new THREE.ConeGeometry(0.72, 0.72, 6), 0.34, 1, 0.82);
    mound.rotation.y = Math.PI / 6;
    addMesh(new THREE.CylinderGeometry(0.38, 0.52, 0.22, 6), 0.11);
    const marker = addMesh(new THREE.BoxGeometry(0.12, 0.8, 0.12), 0.77);
    marker.material = toon('#6f4a31');
    this.materials.push(marker.material as THREE.Material);
  }

  dispose(): void {
    this.geometry.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
    this.group.clear();
  }
}

/** Stable array order resolves equal-distance ties. Reserved flights cannot be targeted twice. */
export function nearestActiveBase(bases: EnemyBase[], origin: THREE.Vector3, attacks: Record<BaseSide, number>, cap = 10): EnemyBase | undefined {
  let nearest: EnemyBase | undefined;
  let distance = Infinity;
  for (const base of bases) {
    if (!base.active || base.destroyed || base.targeted || attacks[base.side] >= Math.min(10, cap)) continue;
    const next = base.group.position.distanceToSquared(origin);
    if (next < distance) { nearest = base; distance = next; }
  }
  return nearest;
}
