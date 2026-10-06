import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';

const glb = readFileSync(new URL('../../public/models/assets.glb', import.meta.url));

async function parse(): Promise<THREE.Group> {
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  return gltf.scene;
}

// Every part the game looks up by name, plus a rough size check (three.js Y-up metres).
const expected: Record<string, { parts: string[]; maxHeight: number }> = {
  goblin: { parts: ['body'], maxHeight: 1.1 }, orc: { parts: ['body'], maxHeight: 1.15 },
  bat: { parts: ['body', 'wing_l', 'wing_r'], maxHeight: 0.6 }, star: { parts: ['mesh'], maxHeight: 0.35 },
  rake: { parts: ['handle', 'base'], maxHeight: 1 }, haystack_plate: { parts: ['mesh'], maxHeight: 0.3 },
  haystack: { parts: ['mesh'], maxHeight: 0.95 }, pan_arm: { parts: ['mesh'], maxHeight: 1.2 },
  pan: { parts: ['mesh'], maxHeight: 0.5 }, air_defence_mast: { parts: ['mesh'], maxHeight: 1.2 },
  air_defence_radar: { parts: ['mesh'], maxHeight: 0.85 }, base_goblin: { parts: ['mesh'], maxHeight: 1.6 },
  base_orc: { parts: ['mesh'], maxHeight: 1.4 }, fence: { parts: ['mesh'], maxHeight: 0.75 },
  tree_pine: { parts: ['mesh'], maxHeight: 0.9 }, tree_round: { parts: ['mesh'], maxHeight: 0.8 },
  flower: { parts: ['mesh'], maxHeight: 0.16 }, pot: { parts: ['body', 'detail'], maxHeight: 1 },
  cotton_plant: { parts: ['mesh', 'boll'], maxHeight: 0.5 }, cotton_ball: { parts: ['mesh'], maxHeight: 0.6 },
  land: { parts: ['mesh'], maxHeight: 0.63 }, bridge_plank: { parts: ['mesh'], maxHeight: 0.07 },
};

describe('Blender model pack', () => {
  it('contains every asset and named part with sane, finite geometry', async () => {
    const scene = await parse();
    expect(scene.children.map((child) => child.name).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, { parts, maxHeight }] of Object.entries(expected)) {
      const root = scene.getObjectByName(name)!;
      for (const part of parts) expect(root.getObjectByName(`${name}_${part}`), `${name}_${part}`).toBeDefined();
      const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
      expect(Number.isFinite(size.x + size.y + size.z), name).toBe(true);
      expect(size.y, name).toBeGreaterThan(0.01);
      expect(size.y, name).toBeLessThanOrEqual(maxHeight);
    }
  });

  it('keeps feet on the ground and faces characters toward +Z', async () => {
    const scene = await parse();
    for (const name of ['goblin', 'orc']) {
      const root = scene.getObjectByName(name)!;
      const box = new THREE.Box3().setFromObject(root);
      expect(box.min.y, name).toBeGreaterThanOrEqual(-0.01);
      // Eyes sit on the front: the model reaches further toward +Z than -Z at head height.
      expect(box.max.z, name).toBeGreaterThan(0.2);
    }
  });

  it('keeps land tiles unit-sized with the top flush at +0.31', async () => {
    const box = new THREE.Box3().setFromObject((await parse()).getObjectByName('land')!);
    expect(box.max.y).toBeCloseTo(0.31, 3);
    expect(box.max.x - box.min.x).toBeCloseTo(1, 2);
    expect(box.max.z - box.min.z).toBeCloseTo(1, 2);
  });

  it('ships recolourable materials the game targets by name', async () => {
    const names = new Set<string>();
    (await parse()).traverse((node) => {
      if (node instanceof THREE.Mesh) (Array.isArray(node.material) ? node.material : [node.material]).forEach((m) => names.add(m.name));
    });
    expect(names).toContain('land_top');
    expect(names).toContain('petal');
  });
});
