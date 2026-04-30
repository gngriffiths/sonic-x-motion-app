import { createSystem, InputComponent, Vector3 } from "@iwsdk/core";
import { particlePool } from "./particle-pool.js";

const WS_URL = `wss://${window.location.host}/osc-bridge`;

const FIST_CURL_THRESHOLD = 0.085;
const FIST_FINGER_COUNT = 3;
const FINGERTIP_JOINTS = [
  'index-finger-tip',
  'middle-finger-tip',
  'ring-finger-tip',
  'pinky-finger-tip',
] as const;

/** Ableton 0-based track index for bloom MIDI output (track 7 in UI). */
const BLOOM_MIDI_TRACK = 6;
const BLOOM_MIDI_CHANNEL = 0;
/** Time window (seconds) to open the hand after fisting to trigger the bloom. */
const BLOOM_WINDOW = 1.0;
/** Duration (seconds) the note plays before auto note-off. */
const BLOOM_NOTE_DURATION = 2.0;
const BLOOM_VELOCITY = 100;
/** Minor pentatonic across two octaves. */
const PENTATONIC_NOTES = [48, 51, 53, 55, 58, 60, 63, 65, 67, 70] as const;

type BloomPhase = 'idle' | 'armed' | 'playing';

export class BloomGestureSystem extends createSystem({}) {
  // ── left hand ─────────────────────────────────────────────────────────────
  private lPhase: BloomPhase = 'idle';
  private lWasFisting = false;
  private lArmedTimer = 0;
  private lPlayTimer = 0;
  private lActiveNote = -1;

  // ── right hand ────────────────────────────────────────────────────────────
  private rPhase: BloomPhase = 'idle';
  private rWasFisting = false;
  private rArmedTimer = 0;
  private rPlayTimer = 0;
  private rActiveNote = -1;

  private handPos!: Vector3;
  private ws!: WebSocket;

  init() {
    this.handPos = new Vector3();
    this.ws = new WebSocket(WS_URL);
    this.ws.addEventListener('open', () => console.log('[Bloom] OSC bridge connected'));
    this.ws.addEventListener('error', (e) => console.warn('[Bloom] OSC bridge error', e));
    this.cleanupFuncs.push(() => {
      if (this.lActiveNote >= 0) this.sendNoteOff(this.lActiveNote);
      if (this.rActiveNote >= 0) this.sendNoteOff(this.rActiveNote);
      this.ws.close();
    });
  }

  private isFisting(side: 'left' | 'right'): boolean {
    const gamepad = this.input.gamepads[side];
    if (!gamepad) return false;

    const hand = gamepad.inputSource.hand as XRHand | undefined;
    if (hand) {
      const frame = this.world.renderer.xr.getFrame() as XRFrame | null;
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

  private sendNoteOn(pitch: number): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: 'note_on',
        track: BLOOM_MIDI_TRACK,
        channel: BLOOM_MIDI_CHANNEL,
        pitch,
        velocity: BLOOM_VELOCITY,
      }),
    );
  }

  private sendNoteOff(pitch: number): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({ type: 'note_off', track: BLOOM_MIDI_TRACK, channel: BLOOM_MIDI_CHANNEL, pitch }),
    );
  }

  update(delta: number) {
    // ── LEFT ──────────────────────────────────────────────────────────────
    {
      const fisting = this.isFisting('left');

      if (fisting && !this.lWasFisting && this.lPhase === 'idle') {
        this.lPhase = 'armed';
        this.lArmedTimer = 0;
      }

      if (this.lPhase === 'armed') {
        this.lArmedTimer += delta;
        if (!fisting && this.lWasFisting) {
          // Hand just opened within the window — trigger bloom
          this.player.gripSpaces.left.getWorldPosition(this.handPos);
          particlePool.spawn(this.handPos.x, this.handPos.y, this.handPos.z);
          this.lActiveNote = PENTATONIC_NOTES[Math.floor(Math.random() * PENTATONIC_NOTES.length)];
          this.sendNoteOn(this.lActiveNote);
          this.lPhase = 'playing';
          this.lPlayTimer = 0;
        } else if (this.lArmedTimer >= BLOOM_WINDOW) {
          // Window expired without opening
          this.lPhase = 'idle';
        }
      }

      if (this.lPhase === 'playing') {
        this.lPlayTimer += delta;
        if (this.lPlayTimer >= BLOOM_NOTE_DURATION) {
          this.sendNoteOff(this.lActiveNote);
          this.lActiveNote = -1;
          this.lPhase = 'idle';
        }
      }

      this.lWasFisting = fisting;
    }

    // ── RIGHT ─────────────────────────────────────────────────────────────
    {
      const fisting = this.isFisting('right');

      if (fisting && !this.rWasFisting && this.rPhase === 'idle') {
        this.rPhase = 'armed';
        this.rArmedTimer = 0;
      }

      if (this.rPhase === 'armed') {
        this.rArmedTimer += delta;
        if (!fisting && this.rWasFisting) {
          this.player.gripSpaces.right.getWorldPosition(this.handPos);
          particlePool.spawn(this.handPos.x, this.handPos.y, this.handPos.z);
          this.rActiveNote = PENTATONIC_NOTES[Math.floor(Math.random() * PENTATONIC_NOTES.length)];
          this.sendNoteOn(this.rActiveNote);
          this.rPhase = 'playing';
          this.rPlayTimer = 0;
        } else if (this.rArmedTimer >= BLOOM_WINDOW) {
          this.rPhase = 'idle';
        }
      }

      if (this.rPhase === 'playing') {
        this.rPlayTimer += delta;
        if (this.rPlayTimer >= BLOOM_NOTE_DURATION) {
          this.sendNoteOff(this.rActiveNote);
          this.rActiveNote = -1;
          this.rPhase = 'idle';
        }
      }

      this.rWasFisting = fisting;
    }
  }
}
