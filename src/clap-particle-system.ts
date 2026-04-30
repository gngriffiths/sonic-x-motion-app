import { createSystem, Quaternion, Vector3 } from "@iwsdk/core";
import { particlePool } from "./particle-pool.js";

const WS_URL = `wss://${window.location.host}/osc-bridge`;

const CLAP_THRESHOLD = 0.22;
const CLAP_COOLDOWN = 0.9;

/** Ableton 0-based track index for clap MIDI output (track 6 in UI). */
const CLAP_MIDI_TRACK = 5;
const CLAP_MIDI_CHANNEL = 0;
/** Minor pentatonic across two octaves — musically safe random notes. */
const PENTATONIC_NOTES = [48, 51, 53, 55, 58, 60, 63, 65, 67, 70] as const;

export class ClapParticleSystem extends createSystem({}) {
  private leftPos!: Vector3;
  private rightPos!: Vector3;
  private midPos!: Vector3;
  private camQ!: Quaternion;
  private wasClose = false;
  private cooldown = 0;

  /** MIDI note state. */
  private clapHeld = false;
  private activeNote = -1;
  private midiWs!: WebSocket;

  init() {
    this.leftPos = new Vector3();
    this.rightPos = new Vector3();
    this.midPos = new Vector3();
    this.camQ = new Quaternion();

    particlePool.init(this.world);

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
    particlePool.update(delta, this.camQ);
  }
}
