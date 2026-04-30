import { createSystem, Quaternion, Vector3 } from "@iwsdk/core";
import { particlePool } from "./particle-pool.js";

const WS_URL = `wss://${window.location.host}/osc-bridge`;

const CLAP_THRESHOLD = 0.22;
const CLAP_COOLDOWN = 0.9;

/** Ableton 0-based track index for clap output (track 6 in UI). */
const CLAP_MIDI_TRACK = 5;

/** Seconds after firing before the track is stopped. */
const CLAP_STOP_DELAY = 1.0;

export class ClapParticleSystem extends createSystem({}) {
  private leftPos!: Vector3;
  private rightPos!: Vector3;
  private midPos!: Vector3;
  private camQ!: Quaternion;
  private wasClose = false;
  private cooldown = 0;
  /** Counts down to zero then stops the track; -1 means inactive. */
  private stopTimer = -1;

  private midiWs!: WebSocket;

  init() {
    this.leftPos = new Vector3();
    this.rightPos = new Vector3();
    this.midPos = new Vector3();
    this.camQ = new Quaternion();

    particlePool.init(this.world);

    this.midiWs = new WebSocket(WS_URL);
    this.cleanupFuncs.push(() => this.midiWs.close());
  }

  private fireTrack(): void {
    if (this.midiWs.readyState !== WebSocket.OPEN) return;
    this.midiWs.send(JSON.stringify({ type: 'fire_track', track: CLAP_MIDI_TRACK }));
  }

  private stopTrack(): void {
    if (this.midiWs.readyState !== WebSocket.OPEN) return;
    this.midiWs.send(JSON.stringify({ type: 'stop_track', track: CLAP_MIDI_TRACK }));
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
        particlePool.spawn(this.midPos.x, this.midPos.y, this.midPos.z);
        this.cooldown = CLAP_COOLDOWN;
        this.stopTimer = CLAP_STOP_DELAY;
        this.fireTrack();
      }

      this.wasClose = close;
    }

    if (this.stopTimer > 0) {
      this.stopTimer -= delta;
      if (this.stopTimer <= 0) {
        this.stopTimer = -1;
        this.stopTrack();
      }
    }

    this.camQ.copy(this.world.camera.quaternion);
    particlePool.update(delta, this.camQ);
  }
}
