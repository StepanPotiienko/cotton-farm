import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Low-poly models authored in Blender (tools/blender) and shipped as one GLB. */
export type ModelName =
  | 'goblin' | 'orc' | 'bat' | 'star'
  | 'rake' | 'haystack_plate' | 'haystack' | 'pan_arm' | 'pan' | 'air_defence_mast' | 'air_defence_radar'
  | 'base_goblin' | 'base_orc' | 'fence' | 'tree_pine' | 'tree_round' | 'flower' | 'pot'
  | 'cotton_plant' | 'cotton_ball' | 'land' | 'bridge_plank';

const library = new Map<string, THREE.Object3D>();
const toonCache = new Map<string, THREE.MeshToonMaterial>();
let gradient: THREE.DataTexture | undefined;

function toonFor(source: THREE.Material): THREE.MeshToonMaterial {
  const color = (source as THREE.MeshStandardMaterial).color ?? new THREE.Color('#ffffff');
  const key = `${source.name}:${color.getHexString()}`;
  let material = toonCache.get(key);
  if (!material) {
    if (!gradient) {
      gradient = new THREE.DataTexture(new Uint8Array([48, 118, 190, 255]), 4, 1, THREE.RedFormat);
      gradient.needsUpdate = true;
    }
    material = new THREE.MeshToonMaterial({ color, gradientMap: gradient, name: source.name });
    toonCache.set(key, material);
  }
  return material;
}

/**
 * GLTFLoader splits multi-material parts into a Group of meshes; merge them back
 * into one Mesh per part (material groups) so the game can outline and animate it.
 * Exported PBR materials are swapped for the game's shared toon look.
 */
function prepare(root: THREE.Object3D): void {
  root.position.set(0, 0, 0);
  for (const part of [...root.children]) {
    if ((part as THREE.Mesh).isMesh || !part.children.length || !part.children.every((child) => (child as THREE.Mesh).isMesh)) continue;
    const meshes = part.children as THREE.Mesh[];
    const geometry = mergeGeometries(meshes.map((mesh) => mesh.geometry), true);
    if (!geometry) throw new Error(`Cannot merge model part ${part.name}`);
    const merged = new THREE.Mesh(geometry, meshes.map((mesh) => mesh.material as THREE.Material));
    merged.name = part.name;
    merged.position.copy(part.position); merged.quaternion.copy(part.quaternion); merged.scale.copy(part.scale);
    root.remove(part);
    root.add(merged);
  }
  root.traverse((object) => {
    const node = object as THREE.Mesh;
    if (!node.isMesh) return;
    node.material = Array.isArray(node.material) ? node.material.map(toonFor) : toonFor(node.material);
    node.castShadow = true;
    node.receiveShadow = true;
    node.userData.sharedModel = true;
  });
}

/** Dispose a subtree's GPU resources, skipping geometry/materials shared with the model library. */
export function disposeObject(object: THREE.Object3D): void {
  object.traverse((node) => {
    const child = node as THREE.Mesh;
    if (!child.isMesh || child.userData.sharedModel) return;
    child.geometry.dispose();
    (Array.isArray(child.material) ? child.material : [child.material]).forEach((material) => material.dispose());
  });
}

export async function loadModels(url = `${import.meta.env.BASE_URL}models/assets.glb`): Promise<void> {
  const gltf = await new GLTFLoader().loadAsync(url);
  for (const root of [...gltf.scene.children]) {
    prepare(root);
    library.set(root.name, root);
  }
}

export function hasModel(name: ModelName): boolean { return library.has(name); }

/**
 * Clone a model (geometry and materials are shared). Returns null when models
 * are not loaded, e.g. in unit tests, so callers keep their primitive fallback.
 * `recolor` maps material names to colours and gives the clone private copies.
 */
export function cloneModel(name: ModelName, recolor?: Record<string, THREE.ColorRepresentation>): THREE.Group | null {
  const source = library.get(name);
  if (!source) return null;
  const clone = source.clone(true) as THREE.Group;
  if (recolor) {
    clone.traverse((object) => {
      const node = object as THREE.Mesh;
      if (!node.isMesh) return;
      const swap = (m: THREE.Material) => {
        const color = recolor[m.name];
        if (color === undefined) return m;
        const copy = (m as THREE.MeshToonMaterial).clone();
        copy.color.set(color);
        return copy;
      };
      node.material = Array.isArray(node.material) ? node.material.map(swap) : swap(node.material);
    });
  }
  return clone;
}

/** Find a named part of a cloned model, e.g. part(rake, 'handle') -> "rake_handle". */
export function modelPart(model: THREE.Object3D, part: string): THREE.Object3D | undefined {
  return model.getObjectByName(`${model.name}_${part}`);
}
