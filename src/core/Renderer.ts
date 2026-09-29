import * as THREE from 'three';
import config from '../state/config/game.json';
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  readonly renderer: THREE.WebGLRenderer;
  readonly root = new THREE.Group();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private theta = 0.55;
  private phi = 1.08;
  private distance = 9;
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
    this.scene.fog = new THREE.Fog('#f6bc7a', 14, 28);
    this.scene.add(this.root);
    this.scene.add(new THREE.HemisphereLight('#fff4dc', '#8b7048', 1.55));
    const sun = new THREE.DirectionalLight('#ffe2a3', 3.1);
    sun.position.set(-5, 9, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(config.yard.shadowMapSize, config.yard.shadowMapSize);
    sun.shadow.camera.left = -8; sun.shadow.camera.right = 8;
    sun.shadow.camera.top = 8; sun.shadow.camera.bottom = -8;
    this.scene.add(sun);
    this.addOutlinePass();
    this.resize();
    const resizeObserver = new ResizeObserver(() => this.resize());
    resizeObserver.observe(mount);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => { this.dragging = true; this.lastX = event.clientX; this.lastY = event.clientY; canvas.setPointerCapture(event.pointerId); });
    canvas.addEventListener('pointerup', () => { this.dragging = false; });
    canvas.addEventListener('pointermove', (event) => {
      if (!this.dragging) return;
      this.theta -= (event.clientX - this.lastX) * 0.008;
      this.phi = THREE.MathUtils.clamp(this.phi + (event.clientY - this.lastY) * 0.006, 0.55, 1.38);
      this.lastX = event.clientX; this.lastY = event.clientY;
      this.updateCamera();
    });
    canvas.addEventListener('wheel', (event) => { this.distance = THREE.MathUtils.clamp(this.distance + event.deltaY * 0.008, config.yard.cameraMinDistance, config.yard.cameraMaxDistance); this.updateCamera(); }, { passive: true });
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
    this.camera.lookAt(0, 0.3, 0);
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
