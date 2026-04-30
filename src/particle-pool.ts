import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  World,
} from "@iwsdk/core";

const POOL_MAX = 240;
export const POOL_PER_BURST = 80;
export const POOL_LIFETIME = 3.0;
const POOL_SPEED_MIN = 0.5;
const POOL_SPEED_MAX = 1.5;
const PARTICLE_SIZE = 0.04;

const BURST_COLORS: [number, number, number][] = [
  [1.0, 0.97, 0.88],  // cream
  [0.22, 0.22, 0.22], // dark grey
  [0.65, 0.15, 0.95], // purple
  [1.0, 0.88, 0.1],   // yellow
];

function makeGlowTexture(): CanvasTexture {
  const s = 64;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const c = s / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return new CanvasTexture(canvas);
}

class ParticlePool {
  private mesh!: InstancedMesh;
  private dummy!: Object3D;
  private scratchColor!: Color;
  private scratchQ!: Quaternion;

  // Per-particle state — Float32Arrays: zero GC in update()
  private readonly px = new Float32Array(POOL_MAX);
  private readonly py = new Float32Array(POOL_MAX);
  private readonly pz = new Float32Array(POOL_MAX);
  private readonly vx = new Float32Array(POOL_MAX);
  private readonly vy = new Float32Array(POOL_MAX);
  private readonly vz = new Float32Array(POOL_MAX);
  private readonly age = new Float32Array(POOL_MAX).fill(999);

  private slot = 0;
  private ready = false;

  init(world: World): void {
    this.dummy = new Object3D();
    this.scratchColor = new Color();
    this.scratchQ = new Quaternion();

    const mat = new MeshBasicMaterial({
      map: makeGlowTexture(),
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), mat, POOL_MAX);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(35048); // DynamicDrawUsage

    const white = new Color(1, 1, 1);
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    for (let i = 0; i < POOL_MAX; i++) {
      this.mesh.setColorAt(i, white);
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    world.createTransformEntity(this.mesh, {
      parent: world.sceneEntity,
      persistent: true,
    });

    this.ready = true;
  }

  spawn(x: number, y: number, z: number): void {
    if (!this.ready) return;
    for (let i = 0; i < POOL_PER_BURST; i++) {
      const s = this.slot++ % POOL_MAX;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = POOL_SPEED_MIN + Math.random() * (POOL_SPEED_MAX - POOL_SPEED_MIN);
      const sinPhi = Math.sin(phi);

      this.px[s] = x;
      this.py[s] = y;
      this.pz[s] = z;
      this.vx[s] = sinPhi * Math.cos(theta) * speed;
      this.vy[s] = sinPhi * Math.sin(theta) * speed;
      this.vz[s] = Math.cos(phi) * speed;
      this.age[s] = 0;

      const c = BURST_COLORS[Math.floor(Math.random() * BURST_COLORS.length)];
      this.scratchColor.setRGB(c[0], c[1], c[2]);
      this.mesh.setColorAt(s, this.scratchColor);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Call once per frame from whichever system owns the pool. */
  update(delta: number, cameraQuaternion: Quaternion): void {
    if (!this.ready) return;
    this.scratchQ.copy(cameraQuaternion);

    for (let i = 0; i < POOL_MAX; i++) {
      const alive = this.age[i] < POOL_LIFETIME;
      if (alive) {
        this.age[i] += delta;
        this.px[i] += this.vx[i] * delta;
        this.py[i] += this.vy[i] * delta;
        this.pz[i] += this.vz[i] * delta;
      }

      const t = Math.min(1, this.age[i] / POOL_LIFETIME);
      const sz = alive ? PARTICLE_SIZE * (1 - t * t) : 0;

      this.dummy.position.set(this.px[i], this.py[i], this.pz[i]);
      this.dummy.quaternion.copy(this.scratchQ);
      this.dummy.scale.setScalar(sz);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Singleton particle pool — init'd by ClapParticleSystem, usable by any system. */
export const particlePool = new ParticlePool();
