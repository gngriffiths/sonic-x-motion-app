import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  createSystem,
  Entity,
  Hovered,
  InputComponent,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RayInteractable,
  Transform,
  Vector3,
} from "@iwsdk/core";
import { InstrumentTag } from "./instrument-select.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WS_URL = `wss://${window.location.host}/osc-bridge`;

const FIST_CURL_THRESHOLD = 0.085;
const FIST_FINGER_COUNT = 3;
const FINGERTIP_JOINTS = [
  'index-finger-tip',
  'middle-finger-tip',
  'ring-finger-tip',
  'pinky-finger-tip',
] as const;

/** Hand must move this far (m) from the fist-formation point to trigger the yank. */
const YANK_PULL_THRESHOLD = 0.05;
/** Lerp speed (s⁻¹) while instrument flies toward the hand. */
const YANK_SPEED = 10;
/** Lerp speed (s⁻¹) while instrument floats back home. */
const RETURN_SPEED = 6;
/** Manhattan-distance threshold to consider the return animation complete. */
const RETURN_EPSILON = 0.005;
/** Metres of vertical movement that spans the full 0→1 volume range. */
const RANGE_M = 0.5;

type YankPhase = 'idle' | 'armed' | 'yanked' | 'returning';

// ---------------------------------------------------------------------------
// JediForceYankSystem
// ---------------------------------------------------------------------------

export class JediForceYankSystem extends createSystem({
  /** Instruments currently under a ray cursor. */
  hoveredInstruments: { required: [InstrumentTag, RayInteractable, Hovered] },
  /** All instruments — used once in init() to cache home positions. */
  allInstruments: { required: [InstrumentTag, RayInteractable] },
}) {
  /** World-space home positions keyed by entity.index. */
  private homePositions = new Map<number, Vector3>();
  /** Persisted per-track volumes so each new grab starts where the last left off. */
  private trackVolumes = new Map<number, number>([[0, 0], [1, 0], [2, 0]]);

  // ── left hand ─────────────────────────────────────────────────────────────
  private lPhase: YankPhase = 'idle';
  private lWasFisting = false;
  private lFistOrigin!: Vector3;   // hand pos when fist formed (pull detection)
  private lVolumeOrigin!: Vector3; // hand pos when yank triggered (volume baseline)
  private lEntity: Entity | null = null;
  private lBaseVol = 0;
  private lCurrentVol = 0;
  private lTrack = -1;

  // ── right hand ────────────────────────────────────────────────────────────
  private rPhase: YankPhase = 'idle';
  private rWasFisting = false;
  private rFistOrigin!: Vector3;
  private rVolumeOrigin!: Vector3;
  private rEntity: Entity | null = null;
  private rBaseVol = 0;
  private rCurrentVol = 0;
  private rTrack = -1;

  // ── scratch (no per-frame allocation) ─────────────────────────────────────
  private handPos!: Vector3;

  private ws!: WebSocket;

  init() {
    this.lFistOrigin   = new Vector3();
    this.lVolumeOrigin = new Vector3();
    this.rFistOrigin   = new Vector3();
    this.rVolumeOrigin = new Vector3();
    this.handPos       = new Vector3();

    // Cache each instrument's starting world position.
    // allInstruments already contains pre-existing entities at init() time.
    for (const entity of this.queries.allInstruments.entities) {
      const p = entity.getVectorView(Transform, 'position') as Float32Array;
      this.homePositions.set(entity.index, new Vector3(p[0], p[1], p[2]));
    }

    this.ws = new WebSocket(WS_URL);
    this.ws.addEventListener('open', () => console.log('[ForceYank] OSC bridge connected'));
    this.ws.addEventListener('error', e => console.warn('[ForceYank] OSC bridge error', e));
    this.cleanupFuncs.push(() => this.ws.close());
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private isFisting(side: 'left' | 'right'): boolean {
    const gamepad = this.input.gamepads[side];
    if (!gamepad) return false;

    const hand = gamepad.inputSource.hand as XRHand | undefined;
    if (hand) {
      const frame    = this.world.renderer.xr.getFrame() as XRFrame | null;
      const refSpace = this.world.renderer.xr.getReferenceSpace() as XRReferenceSpace | null;
      if (!frame?.getJointPose || !refSpace) return false;

      const wristSpace = hand.get('wrist' as XRHandJoint);
      if (!wristSpace) return false;

      let curled = 0;
      for (const name of FINGERTIP_JOINTS) {
        const tipSpace = hand.get(name as XRHandJoint);
        if (!tipSpace) continue;
        const pose = frame.getJointPose(tipSpace, wristSpace);
        if (!pose) continue;
        const { x, y, z } = pose.transform.position;
        if (x * x + y * y + z * z < FIST_CURL_THRESHOLD * FIST_CURL_THRESHOLD) curled++;
      }
      return curled >= FIST_FINGER_COUNT;
    }
    return gamepad.getButtonPressed(InputComponent.Squeeze);
  }

  /** Returns the first currently-hovered instrument, or null. */
  private getFirstHovered(): Entity | null {
    const it = this.queries.hoveredInstruments.entities.values().next();
    return it.done ? null : it.value;
  }

  private sendVolume(track: number, volume: number): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'instrument_volume', track, volume }));
  }

  /**
   * Lerp an entity's Transform position toward `target`.
   * Returns true once the entity is close enough to consider it arrived.
   */
  private lerpTo(entity: Entity, target: Vector3, speed: number, delta: number): boolean {
    const p = entity.getVectorView(Transform, 'position') as Float32Array;
    const t = Math.min(1, speed * delta);
    p[0] += (target.x - p[0]) * t;
    p[1] += (target.y - p[1]) * t;
    p[2] += (target.z - p[2]) * t;
    return (
      Math.abs(p[0] - target.x) +
      Math.abs(p[1] - target.y) +
      Math.abs(p[2] - target.z) < RETURN_EPSILON
    );
  }

  // ── update ────────────────────────────────────────────────────────────────

  update(delta: number) {
    // ── LEFT ──────────────────────────────────────────────────────────────
    {
      const fisting = this.isFisting('left');
      this.player.gripSpaces.left.getWorldPosition(this.handPos);

      // Leading edge: fist just formed — arm the gesture on the hovered instrument
      if (fisting && !this.lWasFisting) {
        const hovered = this.getFirstHovered();
        if (hovered) {
          this.lPhase    = 'armed';
          this.lEntity   = hovered;
          this.lTrack    = hovered.getValue(InstrumentTag, 'trackIndex') as number;
          this.lBaseVol  = this.trackVolumes.get(this.lTrack) ?? 0;
          this.lFistOrigin.copy(this.handPos);
        }
      }

      // Armed → check for pull-back threshold
      if (fisting && this.lPhase === 'armed') {
        const dx = this.handPos.x - this.lFistOrigin.x;
        const dy = this.handPos.y - this.lFistOrigin.y;
        const dz = this.handPos.z - this.lFistOrigin.z;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) >= YANK_PULL_THRESHOLD) {
          this.lPhase = 'yanked';
          this.lVolumeOrigin.copy(this.handPos);
        }
      }

      // Yanked → fly instrument to hand + control volume with Y
      if (fisting && this.lPhase === 'yanked' && this.lEntity) {
        this.lerpTo(this.lEntity, this.handPos, YANK_SPEED, delta);

        const yDelta    = (this.handPos.y - this.lVolumeOrigin.y) / RANGE_M;
        this.lCurrentVol = Math.max(0, Math.min(1, this.lBaseVol + yDelta));
        this.sendVolume(this.lTrack, this.lCurrentVol);
      }

      // Trailing edge: fist released
      if (!fisting && this.lWasFisting) {
        if (this.lPhase === 'yanked') {
          this.trackVolumes.set(this.lTrack, this.lCurrentVol);
          this.lPhase = 'returning';
        } else {
          this.lPhase  = 'idle';
          this.lEntity = null;
        }
      }

      // Return animation (runs independently of fist state)
      if (this.lPhase === 'returning' && this.lEntity) {
        const home = this.homePositions.get(this.lEntity.index)!;
        if (this.lerpTo(this.lEntity, home, RETURN_SPEED, delta)) {
          this.lPhase  = 'idle';
          this.lEntity = null;
        }
      }

      this.lWasFisting = fisting;
    }

    // ── RIGHT ─────────────────────────────────────────────────────────────
    {
      const fisting = this.isFisting('right');
      this.player.gripSpaces.right.getWorldPosition(this.handPos);

      if (fisting && !this.rWasFisting) {
        const hovered = this.getFirstHovered();
        if (hovered) {
          this.rPhase    = 'armed';
          this.rEntity   = hovered;
          this.rTrack    = hovered.getValue(InstrumentTag, 'trackIndex') as number;
          this.rBaseVol  = this.trackVolumes.get(this.rTrack) ?? 0;
          this.rFistOrigin.copy(this.handPos);
        }
      }

      if (fisting && this.rPhase === 'armed') {
        const dx = this.handPos.x - this.rFistOrigin.x;
        const dy = this.handPos.y - this.rFistOrigin.y;
        const dz = this.handPos.z - this.rFistOrigin.z;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) >= YANK_PULL_THRESHOLD) {
          this.rPhase = 'yanked';
          this.rVolumeOrigin.copy(this.handPos);
        }
      }

      if (fisting && this.rPhase === 'yanked' && this.rEntity) {
        this.lerpTo(this.rEntity, this.handPos, YANK_SPEED, delta);

        const yDelta     = (this.handPos.y - this.rVolumeOrigin.y) / RANGE_M;
        this.rCurrentVol = Math.max(0, Math.min(1, this.rBaseVol + yDelta));
        this.sendVolume(this.rTrack, this.rCurrentVol);
      }

      if (!fisting && this.rWasFisting) {
        if (this.rPhase === 'yanked') {
          this.trackVolumes.set(this.rTrack, this.rCurrentVol);
          this.rPhase = 'returning';
        } else {
          this.rPhase  = 'idle';
          this.rEntity = null;
        }
      }

      if (this.rPhase === 'returning' && this.rEntity) {
        const home = this.homePositions.get(this.rEntity.index)!;
        if (this.lerpTo(this.rEntity, home, RETURN_SPEED, delta)) {
          this.rPhase  = 'idle';
          this.rEntity = null;
        }
      }

      this.rWasFisting = fisting;
    }
  }
}

// ---------------------------------------------------------------------------
// Clap Particle System
// ---------------------------------------------------------------------------

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

    // Pre-initialize: white color, scale 0 (hidden)
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
    // Clap detection: both hands close together, edge-triggered
    if (this.cooldown > 0) this.cooldown -= delta;

    const lg = this.input.gamepads.left;
    const rg = this.input.gamepads.right;
    if (lg && rg) {
      this.player.gripSpaces.left.getWorldPosition(this.leftPos);
      this.player.gripSpaces.right.getWorldPosition(this.rightPos);
      const close = this.leftPos.distanceTo(this.rightPos) < CLAP_THRESHOLD;

      // Leading edge: hands just came together
      if (close && !this.wasClose && this.cooldown <= 0) {
        this.midPos.addVectors(this.leftPos, this.rightPos).multiplyScalar(0.5);
        this.spawn(this.midPos.x, this.midPos.y, this.midPos.z);
        this.cooldown = CLAP_COOLDOWN;

        // Pick a new random pentatonic note and send MIDI note-on
        const pitch = PENTATONIC_NOTES[Math.floor(Math.random() * PENTATONIC_NOTES.length)];
        this.activeNote = pitch;
        this.clapHeld = true;
        this.sendNoteOn(pitch);
      }

      // Trailing edge: hands just separated
      if (!close && this.wasClose && this.clapHeld) {
        this.sendNoteOff(this.activeNote);
        this.clapHeld = false;
        this.activeNote = -1;
      }

      this.wasClose = close;
    }

    // Billboard quaternion: face the camera
    this.camQ.copy(this.world.camera.quaternion);

    // Advance and render all particles
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
