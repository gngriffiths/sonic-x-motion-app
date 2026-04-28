import {
  createSystem,
  InputComponent,
  Mesh,
  MeshStandardMaterial,
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
        this.leftBaseVolume = this.trackVolumes.get(this.leftTrackAtStart) ?? 0.5;
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
        this.rightBaseVolume = this.trackVolumes.get(this.rightTrackAtStart) ?? 0.5;
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
