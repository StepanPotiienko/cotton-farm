import * as THREE from 'three';
import config from '../state/config/game.json';
// Frame the yard and both first base supports, including their vertical landmarks.
export const INITIAL_CAMERA = { theta: 0.35, phi: 0.85, distance: 36 } as const;
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 250);
  readonly renderer: THREE.WebGLRenderer;
  readonly root = new THREE.Group();
  private pointers = new Map<number, { x: number; y: number }>();
  private lastPinchDistance: number | null = null;
  private theta: number = INITIAL_CAMERA.theta;
  private phi: number = INITIAL_CAMERA.phi;
  private distance: number = INITIAL_CAMERA.distance;
  private target = new THREE.Vector3(0, 0.3, 0);
  private panPointers = new Set<number>();
  constructor(private readonly mount: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.mount.append(this.renderer.domElement);
    this.scene.background = null;
    this.renderer.setClearColor(0x000000, 0);
    this.scene.fog = new THREE.Fog('#f6bc7a', 100, 220);
    this.scene.add(this.root);
    this.scene.add(new THREE.HemisphereLight('#fff4dc', '#8b7048', 1.55));
    const sun = new THREE.DirectionalLight('#ffe2a3', 3.1);
    sun.position.set(-5, 9, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(config.yard.shadowMapSize, config.yard.shadowMapSize);
    sun.shadow.camera.left = -45; sun.shadow.camera.right = 45;
    sun.shadow.camera.top = 45; sun.shadow.camera.bottom = -45;
    sun.shadow.camera.far = 150;
    this.scene.add(sun);
    this.addOutlinePass();
    this.resize();
    const resizeObserver = new ResizeObserver(() => this.resize());
    resizeObserver.observe(mount);
    this.bindCameraControls();
  }
  private bindCameraControls(): void {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('contextmenu', event => event.preventDefault());
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button === 2 || event.shiftKey) this.panPointers.add(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas.setPointerCapture(event.pointerId);
      this.lastPinchDistance = this.pointers.size === 2 ? this.pinchDistance() : null;
    });
    const releasePointer = (event: PointerEvent) => {
      this.pointers.delete(event.pointerId);
      this.panPointers.delete(event.pointerId);
      this.lastPinchDistance = this.pointers.size === 2 ? this.pinchDistance() : null;
    };
    canvas.addEventListener('pointerup', releasePointer);
    canvas.addEventListener('pointercancel', releasePointer);
    canvas.addEventListener('lostpointercapture', releasePointer);
    canvas.addEventListener('pointermove', (event) => {
      const previous = this.pointers.get(event.pointerId);
      if (!previous) return;
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size >= 2) {
        this.pan(dx / 2, dy / 2);
        const distance = this.pinchDistance();
        if (this.lastPinchDistance !== null && distance > 0) {
          this.distance = THREE.MathUtils.clamp(this.distance - (distance - this.lastPinchDistance) * 0.012, config.yard.cameraMinDistance, 100);
          this.updateCamera();
        }
        this.lastPinchDistance = distance;
        this.updateCamera();
        return;
      }
      if (this.panPointers.has(event.pointerId)) { this.pan(dx, dy); this.updateCamera(); return; }
      this.theta -= dx * 0.008;
      this.phi = THREE.MathUtils.clamp(this.phi + dy * 0.006, 0.55, 1.38);
      this.updateCamera();
    });
    canvas.addEventListener('wheel', (event) => { this.distance = THREE.MathUtils.clamp(this.distance + event.deltaY * 0.025, config.yard.cameraMinDistance, 100); this.updateCamera(); }, { passive: true });
  }
  toon(color: THREE.ColorRepresentation): THREE.MeshToonMaterial {
    const data = new Uint8Array([48, 118, 190, 255]);
    const gradient = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
    gradient.needsUpdate = true;
    return new THREE.MeshToonMaterial({ color, gradientMap: gradient });
  }
  render(): void { this.renderer.render(this.scene, this.camera); }
  dispose(): void { this.renderer.dispose(); this.mount.replaceChildren(); }
  private updateCamera(): void {
    this.camera.position.set(this.distance * Math.sin(this.phi) * Math.sin(this.theta), this.distance * Math.cos(this.phi), this.distance * Math.sin(this.phi) * Math.cos(this.theta));
    this.camera.position.add(this.target);
    this.camera.lookAt(this.target);
  }
  private pan(dx: number, dy: number): void {
    const scale = 2 * this.distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / Math.max(1, this.mount.clientHeight);
    this.target.x -= (Math.cos(this.theta) * dx + Math.sin(this.theta) * dy) * scale;
    this.target.z += (Math.sin(this.theta) * dx - Math.cos(this.theta) * dy) * scale;
    this.target.x = THREE.MathUtils.clamp(this.target.x, -40, 40);
    this.target.z = THREE.MathUtils.clamp(this.target.z, -40, 40);
  }
  private pinchDistance(): number {
    const [first, second] = [...this.pointers.values()];
    return first && second ? Math.hypot(second.x - first.x, second.y - first.y) : 0;
  }
  private resize(): void {
    const width = Math.max(1, this.mount.clientWidth); const height = Math.max(1, this.mount.clientHeight);
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); this.renderer.setSize(width, height, false); this.updateCamera();
  }
  private addOutlinePass(): void {
    const outline = new THREE.MeshBasicMaterial({ color: '#493a2c', side: THREE.BackSide });
    this.scene.userData.outlineMaterial = outline;
    // Primitive meshes use a dark back-face silhouette pass via a matching scaled shell.
    this.scene.userData.addOutlined = (mesh: THREE.Mesh, scale = 1.035) => {
      const shell = new THREE.Mesh(mesh.geometry, outline);
      shell.scale.setScalar(scale); shell.castShadow = false; mesh.add(shell);
    };
  }
}
