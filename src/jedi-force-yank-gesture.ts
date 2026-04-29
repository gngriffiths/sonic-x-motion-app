import {
  createSystem,
  Entity,
  Hovered,
  InputComponent,
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

  /** Lerp an entity's uniform scale toward `targetScale`. */
  private lerpScale(entity: Entity, targetScale: number, speed: number, delta: number): void {
    const s = entity.getVectorView(Transform, 'scale') as Float32Array;
    const t = Math.min(1, speed * delta);
    const next = s[0] + (targetScale - s[0]) * t;
    s[0] = next; s[1] = next; s[2] = next;
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
        this.lerpScale(this.lEntity, 0.3, YANK_SPEED, delta);

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
        this.lerpScale(this.lEntity, 1.0, RETURN_SPEED, delta);
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
        this.lerpScale(this.rEntity, 0.3, YANK_SPEED, delta);

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
        this.lerpScale(this.rEntity, 1.0, RETURN_SPEED, delta);
        if (this.lerpTo(this.rEntity, home, RETURN_SPEED, delta)) {
          this.rPhase  = 'idle';
          this.rEntity = null;
        }
      }

      this.rWasFisting = fisting;
    }
  }
}

