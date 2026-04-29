import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  createSystem,
  InputComponent,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "@iwsdk/core";
import { InstrumentTag, InstrumentSelected } from "./instrument-select.js";

/** Movement range in metres from fist origin that maps to +/-1.0 on each axis. */
const RANGE_M = 0.5;

/** WebSocket URL -- derived from window.location so it works both on the local
 *  browser (localhost) and on a Meta Quest connected via LAN (PC's IP address). */
const WS_URL = `wss://${window.location.host}/osc-bridge`;

/**
 * Distance (metres) from wrist to fingertip below which a finger counts as
 * "curled". Open hand ~14-18 cm, closed fist ~4-8 cm.
 */
const FIST_CURL_THRESHOLD = 0.085;
const FIST_FINGER_COUNT = 3; // require at least 3 of 4 fingers curled

const FINGERTIP_JOINTS = [
  'index-finger-tip',
  'middle-finger-tip',
  'ring-finger-tip',
  'pinky-finger-tip',
] as const;

export class PinchSphereSystem extends createSystem({
  selectedInstrument: { required: [InstrumentTag, InstrumentSelected] },
}) {
  private leftSphere!: Mesh;
  private rightSphere!: Mesh;

  /** Pre-allocated scratch vectors -- no allocations in update(). */
  private pos!: Vector3;
  private leftOrigin!: Vector3;
  private rightOrigin!: Vector3;
  private delta!: Vector3;

  private leftFisting = false;
  private rightFisting = false;

  /** Persisted volume (0–1) per track index, so gestures resume from last position. */
  private trackVolumes: Map<number, number> = new Map();
  /** Volume at the moment each fist was formed — gesture delta is added to this. */
  private leftBaseVolume = 0.5;
  private rightBaseVolume = 0.5;
  /** Track index captured at fist-start, used to save volume on release. */
  private leftTrackAtStart = -1;
  private rightTrackAtStart = -1;
  /** Running accumulated volume for each active fist. */
  private leftCurrentVolume = 0.5;
  private rightCurrentVolume = 0.5;

  private ws!: WebSocket;

  init() {
    this.pos = new Vector3();
    this.leftOrigin = new Vector3();
    this.rightOrigin = new Vector3();
    this.delta = new Vector3();

    // Match Ableton's initial state set by the OSC bridge on page load
    this.trackVolumes.set(0, 0);
    this.trackVolumes.set(1, 0);
    this.trackVolumes.set(2, 0);

    const geo = new SphereGeometry(0.015, 16, 16);
    const mat = new MeshStandardMaterial({
      color: 0xff7700,
      roughness: 0.3,
      metalness: 0.1,
    });

    this.leftSphere = new Mesh(geo, mat);
    this.leftSphere.visible = false;
    this.world.createTransformEntity(this.leftSphere, {
      parent: this.world.sceneEntity,
      persistent: true,
    });

    this.rightSphere = new Mesh(geo, mat);
    this.rightSphere.visible = false;
    this.world.createTransformEntity(this.rightSphere, {
      parent: this.world.sceneEntity,
      persistent: true,
    });

    this.ws = new WebSocket(WS_URL);
    this.ws.addEventListener('open', () =>
      console.log('[FistControlGesture] OSC bridge connected'),
    );
    this.ws.addEventListener('error', (e) =>
      console.warn('[FistControlGesture] OSC bridge error', e),
    );

    this.cleanupFuncs.push(() => this.ws.close());
  }

  /**
   * Returns true when the hand is in a fist using WebXR joint poses.
   * Falls back to the controller Squeeze button when not in hand-tracking mode.
   */
  private isFisting(side: 'left' | 'right'): boolean {
    const gamepad = this.input.gamepads[side];
    if (!gamepad) return false;

    const hand = gamepad.inputSource.hand as XRHand | undefined;

    if (hand) {
      // Hand-tracking mode: measure fingertip-to-wrist distances
      const frame = this.world.renderer.xr.getFrame() as XRFrame | null;
      const refSpace = this.world.renderer.xr.getReferenceSpace() as XRReferenceSpace | null;
      if (!frame?.getJointPose || !refSpace) return false;

      const wristSpace = hand.get('wrist' as XRHandJoint);
      if (!wristSpace) return false;

      let curled = 0;
      for (const jointName of FINGERTIP_JOINTS) {
        const tipSpace = hand.get(jointName as XRHandJoint);
        if (!tipSpace) continue;
        const pose = frame.getJointPose(tipSpace, wristSpace);
        if (!pose) continue;
        const { x, y, z } = pose.transform.position;
        if (x * x + y * y + z * z < FIST_CURL_THRESHOLD * FIST_CURL_THRESHOLD) {
          curled++;
        }
      }
      return curled >= FIST_FINGER_COUNT;
    }

    // Controller mode: use physical Squeeze/grip button
    return gamepad.getButtonPressed(InputComponent.Squeeze);
  }

  private getSelectedTrack(): number {
    const selected = this.queries.selectedInstrument.entities.values().next().value;
    return selected !== undefined
      ? (selected.getValue(InstrumentTag, 'trackIndex') as number)
      : -1;
  }

  private sendOSC(hand: 'left' | 'right', x: number, y: number, z: number, volume: number): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const track = this.getSelectedTrack();
    this.ws.send(JSON.stringify({ hand, track, x, y, z, volume }));
  }

  update() {
    // -- Left hand
    const leftFisting = this.isFisting('left');

    if (leftFisting) {
      this.player.gripSpaces.left.getWorldPosition(this.pos);

      if (!this.leftFisting) {
        this.leftOrigin.copy(this.pos);
        this.leftTrackAtStart = this.getSelectedTrack();
        this.leftBaseVolume = this.trackVolumes.get(this.leftTrackAtStart) ?? 0;
      }

      this.leftSphere.position.copy(this.pos);
      this.leftSphere.visible = true;

      this.delta.subVectors(this.pos, this.leftOrigin).divideScalar(RANGE_M);
      this.leftCurrentVolume = Math.max(0, Math.min(1, this.leftBaseVolume + this.delta.y));
      this.sendOSC(
        'left',
        Math.max(-1, Math.min(1, this.delta.x)),
        Math.max(-1, Math.min(1, this.delta.y)),
        Math.max(-1, Math.min(1, this.delta.z)),
        this.leftCurrentVolume,
      );
    } else {
      if (this.leftFisting && this.leftTrackAtStart >= 0) {
        this.trackVolumes.set(this.leftTrackAtStart, this.leftCurrentVolume);
      }
      this.leftSphere.visible = false;
    }
    this.leftFisting = leftFisting;

    // -- Right hand
    const rightFisting = this.isFisting('right');

    if (rightFisting) {
      this.player.gripSpaces.right.getWorldPosition(this.pos);

      if (!this.rightFisting) {
        this.rightOrigin.copy(this.pos);
        this.rightTrackAtStart = this.getSelectedTrack();
        this.rightBaseVolume = this.trackVolumes.get(this.rightTrackAtStart) ?? 0;
      }

      this.rightSphere.position.copy(this.pos);
      this.rightSphere.visible = true;

      this.delta.subVectors(this.pos, this.rightOrigin).divideScalar(RANGE_M);
      this.rightCurrentVolume = Math.max(0, Math.min(1, this.rightBaseVolume + this.delta.y));
      this.sendOSC(
        'right',
        Math.max(-1, Math.min(1, this.delta.x)),
        Math.max(-1, Math.min(1, this.delta.y)),
        Math.max(-1, Math.min(1, this.delta.z)),
        this.rightCurrentVolume,
      );
    } else {
      if (this.rightFisting && this.rightTrackAtStart >= 0) {
        this.trackVolumes.set(this.rightTrackAtStart, this.rightCurrentVolume);
      }
      this.rightSphere.visible = false;
    }
    this.rightFisting = rightFisting;
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

const BURST_COLORS: [number, number, number][] = [
  [0.78, 0.78, 0.78], // grey
  [1.0, 1.0, 1.0],    // white
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
      vertexColors: true,
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
      if (close && !this.wasClose && this.cooldown <= 0) {
        this.midPos.addVectors(this.leftPos, this.rightPos).multiplyScalar(0.5);
        this.spawn(this.midPos.x, this.midPos.y, this.midPos.z);
        this.cooldown = CLAP_COOLDOWN;
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
