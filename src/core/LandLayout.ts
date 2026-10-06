import config from '../state/config/game.json';

export const LAND_SIZE = 2.4;
/** Player platforms revealed after base destruction are compact satellite pads. */
export const PLAYER_LAND_SCALE = 0.65;
export const PLAYER_LAND_SIZE = LAND_SIZE * PLAYER_LAND_SCALE;
export function getLandScale(index: number): number {
  if (index <= 1) return 0.78;
  return index % 2 === 0 ? 1.05 : 0.82;
}
export function getLandSize(index: number): number { return LAND_SIZE * getLandScale(index); }
export type LandSide = 'goblin' | 'orc';
export interface LandSlot { id: string; side: LandSide; x: number; z: number; y: number; rotation: number; }

/** Cylinder vertices are (sin(theta), cos(theta)); an edge normal is halfway between vertices. */
export function getIslandLayout(side: LandSide) {
  const island = config.islands.find(i => i.kind === side)!;
  const desired = Math.atan2(island.position[0], island.position[1]);
  const yardStep = Math.PI / 4;
  const rotation = Math.round((desired - yardStep / 2) / yardStep) * yardStep + yardStep / 2;
  const apothem = island.radius * Math.cos(Math.PI / island.segments);
  const distance = config.yard.size / 2 * Math.cos(Math.PI / 8) + apothem;
  return { ...island, topY: -0.03, x: Math.sin(rotation) * distance, z: Math.cos(rotation) * distance,
    rotation, meshRotation: rotation - Math.PI / island.segments, apothem };
}
export function getLandSlots(): LandSlot[] {
  return (['goblin', 'orc'] as const).flatMap(side => {
    const island = getIslandLayout(side);
    return Array.from({ length: Math.min(10, config.cottonAttack.maxPerSide) }, (_, i) => {
      const distance = island.apothem + LAND_SIZE * (i + 0.5);
      return { id: `${side}-${i + 1}`, side, x: island.x + Math.sin(island.rotation) * distance,
        z: island.z + Math.cos(island.rotation) * distance, y: island.topY, rotation: island.rotation };
    });
  });
}
export function getPurchasedSurface(x: number, z: number, purchased: string[], margin = 0) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  for (const slot of getLandSlots()) {
    if (!purchased.includes(slot.id)) continue;
    const dx = x - slot.x, dz = z - slot.z;
    const lx = Math.cos(slot.rotation) * dx - Math.sin(slot.rotation) * dz;
    const lz = Math.sin(slot.rotation) * dx + Math.cos(slot.rotation) * dz;
    // Large traps (e.g. rake) keep legacy center placement on compact pads.
    const surfaceSize = margin > PLAYER_LAND_SIZE / 2 ? LAND_SIZE : getLandSize(Number(slot.id.split('-')[1]));
    if (Math.abs(lx) <= surfaceSize / 2 - margin + 1e-9 && Math.abs(lz) <= surfaceSize / 2 - margin + 1e-9) return slot;
  }
  return null;
}
/** Use the polygon's half-planes rather than its circumcircle (which includes empty corners). */
export function isOnYard(x: number, z: number, margin = 0): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  const apothem = config.yard.size / 2 * Math.cos(Math.PI / 8);
  return Array.from({ length: 8 }, (_, i) => (i + 0.5) * Math.PI / 4)
    .every(angle => x * Math.sin(angle) + z * Math.cos(angle) <= apothem - margin + 1e-9);
}
export function itemMargin(id: string): number | null {
  if (id === 'fence') return 0.55;
  if (id === 'decor-tree') return 0.28;
  if (id === 'haystack' || id === 'rake') return 1;
  return config.traps.some(t => t.id === id) ? 0.75 : null;
}
