import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  createSystem,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "@iwsdk/core";

const WS_URL = `wss://${window.location.host}/osc-bridge`;

const CLAP_MAX = 240;
const CLAP_PER_BURST = 80;
const CLAP_LIFETIME = 3.0;
const CLAP_SPEED_MIN = 0.5;
const CLAP_SPEED_MAX = 1.5;
const CLAP_THRESHOLD = 0.22;
const CLAP_COOLDOWN = 0.9;
const PARTICLE_SIZE = 0.04;

/** Ableton 0-based track index for clap MIDI output (track 6 in UI). */
const CLAP_MIDI_TRACK = 5;
/** MIDI channel (0-based, channel 1). */
const CLAP_MIDI_CHANNEL = 0;
/** Minor pentatonic across two octaves — musically safe random notes. */
const PENTATONIC_NOTES = [48, 51, 53, 55, 58, 60, 63, 65, 67, 70] as const;

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

export class ClapParticleSystem extends createSystem({}) {
  private mesh!: InstancedMesh;
  private dummy!: Object3D;
  private camQ!: Quaternion;
  private scratchColor!: Color;

  // Per-particle state — Float32Arrays: zero GC in update()
  private px = new Float32Array(CLAP_MAX);
  private py = new Float32Array(CLAP_MAX);
  private pz = new Float32Array(CLAP_MAX);
  private vx = new Float32Array(CLAP_MAX);
  private vy = new Float32Array(CLAP_MAX);
  private vz = new Float32Array(CLAP_MAX);
  private age = new Float32Array(CLAP_MAX).fill(999);

  private leftPos!: Vector3;
  private rightPos!: Vector3;
  private midPos!: Vector3;
  private wasClose = false;
  private cooldown = 0;
  private slot = 0;

  /** MIDI note state. */
  private clapHeld = false;
  private activeNote = -1;
  private midiWs!: WebSocket;

  init() {
    this.leftPos = new Vector3();
    this.rightPos = new Vector3();
    this.midPos = new Vector3();
    this.dummy = new Object3D();
    this.camQ = new Quaternion();
    this.scratchColor = new Color();

    const mat = new MeshBasicMaterial({
      map: makeGlowTexture(),
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), mat, CLAP_MAX);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(35048); // DynamicDrawUsage

    const white = new Color(1, 1, 1);
    this.dummy.scale.set(0, 0, 0);
    this.dummy.updateMatrix();
    for (let i = 0; i < CLAP_MAX; i++) {
      this.mesh.setColorAt(i, white);
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    this.world.createTransformEntity(this.mesh, {
      parent: this.world.sceneEntity,
      persistent: true,
    });

    this.midiWs = new WebSocket(WS_URL);
    this.cleanupFuncs.push(() => {
      if (this.activeNote >= 0) this.sendNoteOff(this.activeNote);
      this.midiWs.close();
    });
  }

  private sendNoteOn(pitch: number): void {
    if (this.midiWs.readyState !== WebSocket.OPEN) return;
    this.midiWs.send(
      JSON.stringify({ type: 'note_on', track: CLAP_MIDI_TRACK, channel: CLAP_MIDI_CHANNEL, pitch, velocity: 100 }),
    );
  }

  private sendNoteOff(pitch: number): void {
    if (this.midiWs.readyState !== WebSocket.OPEN) return;
    this.midiWs.send(
      JSON.stringify({ type: 'note_off', track: CLAP_MIDI_TRACK, channel: CLAP_MIDI_CHANNEL, pitch }),
    );
  }

  private spawn(x: number, y: number, z: number): void {
    for (let i = 0; i < CLAP_PER_BURST; i++) {
      const s = this.slot++ % CLAP_MAX;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = CLAP_SPEED_MIN + Math.random() * (CLAP_SPEED_MAX - CLAP_SPEED_MIN);
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

  update(delta: number): void {
    if (this.cooldown > 0) this.cooldown -= delta;

    const lg = this.input.gamepads.left;
    const rg = this.input.gamepads.right;
    if (lg && rg) {
      this.player.gripSpaces.left.getWorldPosition(this.leftPos);
      this.player.gripSpaces.right.getWorldPosition(this.rightPos);
      const close = this.leftPos.distanceTo(this.rightPos) < CLAP_THRESHOLD;

      if (close && !this.wasClose && this.cooldown <= 0) {
        this.midPos.addVectors(this.leftPos, this.rightPos).multiplyScalar(0.5);
        this.spawn(this.midPos.x, this.midPos.y, this.midPos.z);
        this.cooldown = CLAP_COOLDOWN;

        const pitch = PENTATONIC_NOTES[Math.floor(Math.random() * PENTATONIC_NOTES.length)];
        this.activeNote = pitch;
        this.clapHeld = true;
        this.sendNoteOn(pitch);
      }

      if (!close && this.wasClose && this.clapHeld) {
        this.sendNoteOff(this.activeNote);
        this.clapHeld = false;
        this.activeNote = -1;
      }

      this.wasClose = close;
    }

    this.camQ.copy(this.world.camera.quaternion);

    for (let i = 0; i < CLAP_MAX; i++) {
      const alive = this.age[i] < CLAP_LIFETIME;
      if (alive) {
        this.age[i] += delta;
        this.px[i] += this.vx[i] * delta;
        this.py[i] += this.vy[i] * delta;
        this.pz[i] += this.vz[i] * delta;
      }

      const t = Math.min(1, this.age[i] / CLAP_LIFETIME);
      const sz = alive ? PARTICLE_SIZE * (1 - t * t) : 0;

      this.dummy.position.set(this.px[i], this.py[i], this.pz[i]);
      this.dummy.quaternion.copy(this.camQ);
      this.dummy.scale.setScalar(sz);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
