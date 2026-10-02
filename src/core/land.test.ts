import { beforeEach, expect, it } from 'vitest';
import * as THREE from 'three';
import { getLandSlots, getIslandLayout, LAND_SIZE, getPurchasedSurface } from './LandLayout';
import { Game } from './Game';
import { useGameStore } from '../state/store';
import { saveGame, restoreGame } from './Save';
import config from '../state/config/game.json';

beforeEach(() => useGameStore.getState().resetStore());
it('has twenty distinct non-overlapping slots with exact adjoining edges', () => {
  const slots = getLandSlots();
  expect(slots).toHaveLength(20);
  expect(new Set(slots.map(s => `${s.x}/${s.z}`)).size).toBe(20);
  for (const side of ['goblin', 'orc'] as const) {
    const island = getIslandLayout(side), chain = slots.filter(s => s.side === side);
    const n = new THREE.Vector2(Math.sin(island.rotation), Math.cos(island.rotation));
    // Island layout rotation is the chain's outward normal, distinct from mesh rotation.
    expect(new THREE.Vector2(chain[0]!.x - island.x, chain[0]!.z - island.z).dot(n)).toBeCloseTo(island.apothem + LAND_SIZE / 2);
    expect(Math.hypot(island.x, island.z)).toBeCloseTo(config.yard.size / 2 * Math.cos(Math.PI / 8) + island.apothem);
    for (let i = 1; i < chain.length; i++) expect(Math.hypot(chain[i]!.x-chain[i-1]!.x,chain[i]!.z-chain[i-1]!.z)).toBeCloseTo(LAND_SIZE);
  }
  // Separating-axis test on the actual oriented square footprints, including opposite sides.
  for (let i=0;i<slots.length;i++) for(let j=i+1;j<slots.length;j++) {
    const a=slots[i]!,b=slots[j]!;
    const axes=[a.rotation,b.rotation].flatMap(r=>[new THREE.Vector2(Math.cos(r),-Math.sin(r)),new THREE.Vector2(Math.sin(r),Math.cos(r))]);
    expect(axes.some(axis=>{
      const radius=(r:number)=>LAND_SIZE/2*(Math.abs(axis.dot(new THREE.Vector2(Math.cos(r),-Math.sin(r))))+Math.abs(axis.dot(new THREE.Vector2(Math.sin(r),Math.cos(r)))));
      return Math.abs(axis.dot(new THREE.Vector2(b.x-a.x,b.z-a.z)))>=radius(a.rotation)+radius(b.rotation)-1e-8;
    })).toBe(true);
  }
});
it('reveals land at destruction and permits building only after purchase, including restored positions', () => {
  const game=Object.create(Game.prototype) as any;
  Object.assign(game,{renderer:{root:new THREE.Group(),toon:()=>new THREE.MeshToonMaterial()},landPlatforms:new Map(),landDecorations:new Map(),bases:[]});
  game.createLandPlatforms();
  const slot=getLandSlots()[0]!;
  const support = game.landPlatforms.get(slot.id);
  expect(support.visible).toBe(true); expect(support.userData.owner).toBe('enemy');
  expect(game.landPlatforms.get('goblin-2').visible).toBe(false);
  const state=useGameStore.getState();state.growCotton(config.yard.field.growthSeconds);state.launchCotton(slot.id);state.destroyBase(slot.id);
  expect(game.landPlatforms.get(slot.id)).toBe(support);
  expect(support.visible).toBe(true); expect(support.userData.owner).toBe('land');
  expect(game.landPlatforms.get('goblin-2').visible).toBe(true);
  expect(getPurchasedSurface(slot.x,slot.z,[])).toBeNull();
  expect(state.placeItem('fence',slot.x,slot.z)).toBe(false);
  state.earn(1000);state.buyLand(slot.id);state.unlockTrap('rake');
  for(const id of ['fence','decor-tree','rake']) expect(state.placeItem(id,slot.x,slot.z)).toBe(true);
  expect(state.placeItem('fence',slot.x+100,slot.z)).toBe(false);
  const saved=saveGame({setItem:()=>{}});state.resetStore();expect(restoreGame(saved)).toBe(true);
  expect(useGameStore.getState().placed).toEqual(saved.placed);
  game.landPlatformsUnsubscribe();
});

it('pans and zooms with the real camera pointer handlers to reach both tenth slots', async () => {
  const { Renderer } = await import('./Renderer');
  const handlers = new Map<string, (event: any) => void>();
  const renderer = Object.create(Renderer.prototype) as any;
  const camera = new THREE.PerspectiveCamera(34, 1.5, 0.1, 250);
  Object.assign(renderer, { camera, mount: { clientHeight: 800 }, renderer: { domElement: {
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler), setPointerCapture: () => {} } },
    pointers: new Map(), panPointers: new Set(), lastPinchDistance: null, target: new THREE.Vector3(0,0.3,0), distance: 24, theta: 0.55, phi: 1.08 });
  renderer.bindCameraControls();
  for (const slot of getLandSlots().filter(s => s.id.endsWith('-10'))) {
    renderer.target.set(0,0.3,0);
    const scale = 2 * renderer.distance * Math.tan(THREE.MathUtils.degToRad(34 / 2)) / 800;
    const dx = (-Math.cos(renderer.theta)*slot.x + Math.sin(renderer.theta)*slot.z)/scale;
    const dy = (-Math.sin(renderer.theta)*slot.x - Math.cos(renderer.theta)*slot.z)/scale;
    handlers.get('pointerdown')!({pointerId:1,button:2,clientX:0,clientY:0});
    handlers.get('pointermove')!({pointerId:1,clientX:dx,clientY:dy});
    handlers.get('pointerup')!({pointerId:1});
    expect(renderer.target.x).toBeCloseTo(slot.x);expect(renderer.target.z).toBeCloseTo(slot.z);
    handlers.get('wheel')!({deltaY:3000});expect(renderer.distance).toBeGreaterThan(13);
    camera.updateMatrixWorld();
    const projected = new THREE.Vector3(slot.x,slot.y,slot.z).project(camera);
    expect(Math.abs(projected.x)).toBeLessThan(1);expect(Math.abs(projected.y)).toBeLessThan(1);expect(Math.abs(projected.z)).toBeLessThan(1);
    handlers.get('wheel')!({deltaY:-3000});
  }
  const before=renderer.target.clone();
  handlers.get('pointerdown')!({pointerId:1,button:0,clientX:0,clientY:0});
  handlers.get('pointerdown')!({pointerId:2,button:0,clientX:100,clientY:0});
  handlers.get('pointermove')!({pointerId:1,clientX:20,clientY:20});
  expect(renderer.target.equals(before)).toBe(false);
});

it('keeps every slot outside the rendered yard and both island polygons', () => {
  const polygon=(x:number,z:number,r:number,n:number,rotation:number)=>Array.from({length:n},(_,i)=>new THREE.Vector2(x+r*Math.sin(i*2*Math.PI/n+rotation),z+r*Math.cos(i*2*Math.PI/n+rotation)));
  const obstacles=[polygon(0,0,config.yard.size/2,8,0),...(['goblin','orc'] as const).map(side=>{const i=getIslandLayout(side);return polygon(i.x,i.z,i.radius,i.segments,i.meshRotation);})];
  for(const slot of getLandSlots()) {
    const square=[[-1,-1],[-1,1],[1,1],[1,-1]].map(([x,z])=>new THREE.Vector2(slot.x+LAND_SIZE/2*(x!*Math.cos(slot.rotation)+z!*Math.sin(slot.rotation)),slot.z+LAND_SIZE/2*(-x!*Math.sin(slot.rotation)+z!*Math.cos(slot.rotation))));
    for(const obstacle of obstacles) {
      const axes=[square,obstacle].flatMap(poly=>poly.map((p,i)=>{const edge=poly[(i+1)%poly.length]!.clone().sub(p);return new THREE.Vector2(-edge.y,edge.x).normalize();}));
      expect(axes.some(axis=>{const a=square.map(p=>p.dot(axis)),b=obstacle.map(p=>p.dot(axis));return Math.max(...a)<=Math.min(...b)+1e-8||Math.max(...b)<=Math.min(...a)+1e-8;})).toBe(true);
    }
  }
});

it('places a fence by tapping the purchased tenth platform through the actual pointer/raycast path', () => {
  const state = useGameStore.getState();
  for(let i=1;i<=10;i++){state.growCotton(config.yard.field.growthSeconds);state.launchCotton(`goblin-${i}`);state.destroyBase(`goblin-${i}`);}
  state.earn(1000);state.buyLand('goblin-10');
  const slot=getLandSlots().find(s=>s.id==='goblin-10')!;
  const handlers=new Map<string,(event:any)=>void>();
  const camera=new THREE.PerspectiveCamera(34,1,0.1,250);
  camera.position.set(slot.x,slot.y+8,slot.z+4);camera.lookAt(slot.x,slot.y,slot.z);camera.updateMatrixWorld();
  const game=Object.create(Game.prototype) as any;
  Object.assign(game,{running:true,raycaster:new THREE.Raycaster(),landPlatforms:new Map(),landDecorations:new Map(),traps:[],placedBuildings:[],placementIndicator:new THREE.Group(),renderer:{camera,root:new THREE.Group(),toon:()=>new THREE.MeshToonMaterial(),renderer:{domElement:{style:{},getBoundingClientRect:()=>({left:0,top:0,width:800,height:800}),addEventListener:(name:string,handler:(e:any)=>void)=>handlers.set(name,handler)}}}});
  game.createLandPlatforms();game.renderer.root.updateMatrixWorld(true);game.bindTap();
  game.selectBuildingForPlacement('fence');
  const event={pointerId:1,pointerType:'mouse',button:0,isPrimary:true,clientX:400,clientY:400,preventDefault:()=>{},stopImmediatePropagation:()=>{}};
  handlers.get('pointerdown')!(event);handlers.get('pointerup')!(event);
  expect(useGameStore.getState().placed[0]).toMatchObject({itemId:'fence',landId:slot.id});
  expect(game.placedBuildings).toHaveLength(1);
  expect(game.placedBuildings[0].position.x).toBeCloseTo(slot.x);
  expect(game.placedBuildings[0].position.z).toBeCloseTo(slot.z);
  game.landPlatformsUnsubscribe();
});

it('builds the actual diorama with distinct grounded bases and converts the impact slot without replacing its slab', async () => {
  const { EventBus } = await import('./Events');
  const game=Object.create(Game.prototype) as any;
  const scene=new THREE.Scene();scene.userData.addOutlined=()=>{};
  Object.assign(game,{renderer:{scene,root:new THREE.Group(),toon:(color:THREE.ColorRepresentation)=>new THREE.MeshToonMaterial({color})},events:new EventBus(),landPlatforms:new Map(),landDecorations:new Map(),baseReveals:new Map(),flights:[],traps:[],placedBuildings:[]});
  game.createDiorama();
  expect(game.bases).toHaveLength(20);
  for(const slot of getLandSlots()) {
    const base=game.bases.find((b:any)=>b.id===slot.id);
    expect(base.group.position.toArray()).toEqual([slot.x,slot.y,slot.z]);
    expect(game.landPlatforms.get(slot.id).position.y+0.31).toBeCloseTo(slot.y);
    expect(slot.y).toBeCloseTo(-0.03);
  }
  const first=game.bases[0],next=game.bases[1],slab=game.landPlatforms.get(first.id);
  expect(first.group.position.equals(next.group.position)).toBe(false);
  useGameStore.getState().growCotton(config.yard.field.growthSeconds);
  expect(game.launchCotton()).toBe(true);
  const target=game.flights[0].base;
  game.stepCottonFlights(config.cottonAttack.flightSeconds);
  expect(target.destroyed).toBe(true);expect(target.group.visible).toBe(false);
  expect(game.landPlatforms.get(target.id).userData.owner).toBe('land');
  expect(game.landPlatforms.get(first.id)).toBe(slab);
  expect(game.renderer.root.children.filter((child:THREE.Object3D)=>child.name===`land-${first.id}`)).toHaveLength(1);
  game.landPlatformsUnsubscribe();game.landDecorationsUnsubscribe();
});

it('uses identical island render, collider and actual actor spawn positions, with grounded bodies', async () => {
  const { Physics } = await import('./Physics');
  const { EventBus } = await import('./Events');
  const physics=await Physics.create();physics.floor();
  const scene=new THREE.Scene();scene.userData.addOutlined=()=>{};
  const game=Object.create(Game.prototype) as any;
  Object.assign(game,{physics,renderer:{scene,root:new THREE.Group(),toon:(color:THREE.ColorRepresentation)=>new THREE.MeshToonMaterial({color})},events:new EventBus(),landPlatforms:new Map(),landDecorations:new Map(),baseReveals:new Map(),flights:[],traps:[],placedBuildings:[],actors:[],freeActors:[],spawnEdgeZ:0});
  game.createDiorama();
  for(const side of ['goblin','orc'] as const){
    const layout=getIslandLayout(side),render=game.renderer.root.getObjectByName(`island-${side}`);
    expect(render).toBeDefined();
    expect(render.position.toArray()).toEqual([layout.x,layout.topY-layout.height/2,layout.z]);
    const colliders:any[]=[];physics.world.forEachCollider(c=>colliders.push(c));
    const collider=colliders.find(c=>Math.abs(c.translation().x-layout.x)<1e-5&&Math.abs(c.translation().z-layout.z)<1e-5);
    expect(collider).toBeDefined();expect(collider.translation().y).toBeCloseTo(render.position.y);
    game.spawnActor(side);
    const actor=game.actors.at(-1),position=actor.body.translation();
    expect(Math.abs(position.x-layout.x)).toBeLessThanOrEqual(0.111);
    expect(Math.abs(position.z-layout.z)).toBeLessThanOrEqual(0.111);
    const height=side==='orc'?config.orc.height:config.goblin.height;
    expect(position.y-height/2-0.05).toBeCloseTo(layout.topY);
  }
  for(let i=0;i<120;i++) physics.step();
  for(const actor of game.actors) expect(actor.body.translation().y).toBeGreaterThan(0.35);
  game.landPlatformsUnsubscribe();game.landDecorationsUnsubscribe();physics.dispose();
});

it('adds one physics support per visible slab and keeps future hidden slots unsupported', async () => {
  const { Physics }=await import('./Physics');
  const { default: RAPIER }=await import('@dimforge/rapier3d-compat');
  const physics=await Physics.create();physics.floor();physics.syncLandSupport([]);
  const rayHit=(id:string)=>{const s=getLandSlots().find(s=>s.id===id)!;return physics.world.castRay(new RAPIER.Ray({x:s.x,y:5,z:s.z},{x:0,y:-1,z:0}),10,true);};
  const first=rayHit('goblin-1');expect(first).not.toBeNull();expect(first!.timeOfImpact).toBeCloseTo(5-getLandSlots()[0]!.y);
  expect(rayHit('goblin-2')).toBeNull();
  physics.syncLandSupport(['goblin-1']);
  expect(rayHit('goblin-1')!.collider.handle).toBe(first!.collider.handle);
  expect(rayHit('goblin-2')).not.toBeNull();
  let count=0;physics.world.forEachCollider(()=>count++);
  physics.syncLandSupport(['goblin-1']);let repeated=0;physics.world.forEachCollider(()=>repeated++);expect(repeated).toBe(count);
  physics.syncLandSupport([]);expect(rayHit('goblin-2')).toBeNull();
  physics.dispose();
});

it('initially frames the whole yard and both first supports/landmarks with margins on desktop aspects', async () => {
  const { Renderer, INITIAL_CAMERA }=await import('./Renderer');
  for(const aspect of [1,4/3,16/10,16/9,21/9]) {
    const camera=new THREE.PerspectiveCamera(34,aspect,0.1,250);
    const renderer=Object.create(Renderer.prototype) as any;
    Object.assign(renderer,{camera,...INITIAL_CAMERA,target:new THREE.Vector3(0,0.3,0)});
    renderer.updateCamera();camera.updateMatrixWorld();
    const points=Array.from({length:8},(_,i)=>new THREE.Vector3(5*Math.sin(i*Math.PI/4),-0.03,5*Math.cos(i*Math.PI/4)));
    for(const slot of getLandSlots().filter(s=>s.id.endsWith('-1'))) {
      for(const x of [-LAND_SIZE/2,LAND_SIZE/2])for(const z of [-LAND_SIZE/2,LAND_SIZE/2])for(const y of [slot.y-0.62,slot.y+1.5]) {
        points.push(new THREE.Vector3(slot.x+x*Math.cos(slot.rotation)+z*Math.sin(slot.rotation),y,slot.z-x*Math.sin(slot.rotation)+z*Math.cos(slot.rotation)));
      }
    }
    for(const point of points) {
      const projected=point.project(camera);
      expect(Math.abs(projected.x)).toBeLessThan(0.9);
      // Keep clear of top HUD and bottom hint, not merely inside the clip volume.
      expect(Math.abs(projected.y)).toBeLessThan(0.65);
      expect(Math.abs(projected.z)).toBeLessThan(1);
    }
  }
});
