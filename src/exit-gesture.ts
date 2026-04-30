import { createSystem, InputComponent, Quaternion, Vector3 } from "@iwsdk/core";

/**
 * ExitGestureSystem
 *
 * When the left hand is palm-up AND pinching for EXIT_HOLD_DURATION seconds,
 * the WebXR session is ended (returning the user to the Quest menu / browser).
 *
 * Palm-up is detected by checking whether the wrist joint's local Y-axis
 * (which points toward the back/dorsum of the hand) points downward in world
 * space. When that dot product drops below PALM_UP_THRESHOLD the palm is
 * considered to be facing the sky.
 *
 * Only fires during hand-tracking mode — ignored when controllers are active.
 */

/** Dot product of wrist Y-axis with world up must be below this to count as palm-up. */
const PALM_UP_THRESHOLD = -0.5;

/** Seconds both conditions must be held continuously before the session ends. */
const EXIT_HOLD_DURATION = 1.0;

export class ExitGestureSystem extends createSystem({}) {
  private holdTimer = 0;
  private scratchQ!: Quaternion;
  private scratchV!: Vector3;

  init() {
    this.scratchQ = new Quaternion();
    this.scratchV = new Vector3();
  }

  update(delta: number): void {
    const gamepad = this.input.gamepads.left;
    if (!gamepad) {
      this.holdTimer = 0;
      return;
    }

    // Only activate when hand-tracking is active (not controllers).
    const hand = (gamepad.inputSource as XRInputSource).hand as XRHand | undefined;
    if (!hand) {
      this.holdTimer = 0;
      return;
    }

    // Require a pinch (thumb-index pinch → Trigger button).
    if (!gamepad.getButtonPressed(InputComponent.Trigger)) {
      this.holdTimer = 0;
      return;
    }

    // Check palm-up via wrist joint orientation.
    const frame = this.world.renderer.xr.getFrame() as XRFrame | null;
    const refSpace = this.world.renderer.xr.getReferenceSpace() as XRReferenceSpace | null;
    if (!frame?.getJointPose || !refSpace) {
      this.holdTimer = 0;
      return;
    }

    const wristSpace = hand.get('wrist' as XRHandJoint);
    if (!wristSpace) {
      this.holdTimer = 0;
      return;
    }

    const wristPose = frame.getJointPose(wristSpace, refSpace);
    if (!wristPose) {
      this.holdTimer = 0;
      return;
    }

    // Rotate local +Y by the wrist orientation to get the dorsum direction in world space.
    const { x, y, z, w } = wristPose.transform.orientation;
    this.scratchQ.set(x, y, z, w);
    this.scratchV.set(0, 1, 0).applyQuaternion(this.scratchQ);

    // Dorsum pointing down ↔ palm facing up.
    if (this.scratchV.y >= PALM_UP_THRESHOLD) {
      this.holdTimer = 0;
      return;
    }

    this.holdTimer += delta;
    if (this.holdTimer >= EXIT_HOLD_DURATION) {
      this.holdTimer = 0;
      this.world.exitXR();
    }
  }
}
