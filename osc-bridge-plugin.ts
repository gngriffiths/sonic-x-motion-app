import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { Plugin } from 'vite';
import { WebSocketServer, WebSocket } from 'ws';
import { Client, Message, Server } from 'node-osc';

const ABLETON_HOST = '127.0.0.1';
const ABLETON_PORT = 11000;

const INIT_TRACKS = [
  { name: 'drums',    index: 0 },
  { name: 'bass',     index: 1 },
  { name: 'keyboard', index: 2 },
];
const INIT_VOLUME = 0;
const BRIDGE_RECEIVE_PORT = 11001;

export function oscBridgePlugin(): Plugin {
  return {
    name: 'osc-bridge',
    configureServer(server) {
      const oscClient = new Client(ABLETON_HOST, ABLETON_PORT);
      const wss = new WebSocketServer({ noServer: true });

      const trackVolumes = new Map<number, number>(
        INIT_TRACKS.map(t => [t.index, INIT_VOLUME]),
      );

      function broadcast(payload: string): void {
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) client.send(payload);
        });
      }

      // OSC server — receives volume feedback from AbletonOSC on port 11001
      const oscServer = new Server(BRIDGE_RECEIVE_PORT, '0.0.0.0');
      oscServer.on('message', (msg: unknown[]) => {
        const [address, ...args] = msg as [string, ...unknown[]];
        if (address === '/live/track/get/volume' && args.length >= 2) {
          const track = args[0] as number;
          const volume = args[1] as number;
          trackVolumes.set(track, volume);
          broadcast(JSON.stringify({ type: 'volume_update', track, volume }));
        }
      });

      function sendOSC(address: string, ...args: Array<string | number | boolean>): void {
        const msg = new Message(address);
        for (const arg of args) msg.append(arg);
        oscClient.send(msg, (err?: Error | null) => {
          if (err) console.error('[osc-bridge] OSC send error:', err.message);
        });
      }

      server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (req.url === '/osc-bridge') {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
          });
        }
      });

      wss.on('connection', (ws) => {
        console.log('\x1b[36m[osc-bridge]\x1b[0m client connected');

        for (const track of INIT_TRACKS) {
          sendOSC('/live/track/set/volume', track.index, INIT_VOLUME);
        }
        console.log('\x1b[36m[osc-bridge]\x1b[0m Ableton tracks initialised (volume → 0)');

        // Subscribe to continuous volume feedback from AbletonOSC
        for (const track of INIT_TRACKS) {
          sendOSC('/live/track/start_listen/volume', track.index);
        }

        // Send current volume state to the newly connected client
        for (const [track, volume] of trackVolumes) {
          ws.send(JSON.stringify({ type: 'volume_update', track, volume }));
        }

        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString()) as Record<string, unknown>;

            // Instrument volume control: { type: 'instrument_volume', track, volume }
            if (msg.type === 'instrument_volume') {
              const { track, volume } = msg as { track: number; volume: number };
              sendOSC('/live/track/set/volume', track, volume);
              trackVolumes.set(track, volume);
              broadcast(JSON.stringify({ type: 'volume_update', track, volume }));
              return;
            }

            // fire_track: fire clip slot 0 on a track (plays whatever clip is there)
            if (msg.type === 'fire_track') {
              const { track } = msg as { track: number };
              sendOSC('/live/clip/fire', track, 0);
              return;
            }

            // stop_track: stop clip slot 0 on a track
            if (msg.type === 'stop_track') {
              const { track } = msg as { track: number };
              sendOSC('/live/clip/stop', track, 0);
              return;
            }

            // MIDI note on: create/replace a clip with the chosen pitch, then fire it
            // Uses documented AbletonOSC clip API (no /live/track/send_midi_note_on exists)
            if (msg.type === 'note_on') {
              const { track, pitch, velocity } = msg as {
                track: number; pitch: number; velocity: number;
              };
              // Delete any existing clip in slot 0, create a fresh 32-beat one, fill it, fire
              sendOSC('/live/clip_slot/delete_clip', track, 0);
              sendOSC('/live/clip_slot/create_clip', track, 0, 32);
              // add/notes: track, clip, pitch, start_time, duration, velocity, mute
              sendOSC('/live/clip/add/notes', track, 0, pitch, 0, 31.9, velocity, 0);
              sendOSC('/live/clip/fire', track, 0);
              return;
            }

            // play_bar: create a 1-bar (4-beat) non-looping clip, fire once, auto-stops
            if (msg.type === 'play_bar') {
              const { track, pitch, velocity } = msg as {
                track: number; pitch: number; velocity: number;
              };
              sendOSC('/live/clip_slot/delete_clip', track, 0);
              sendOSC('/live/clip_slot/create_clip', track, 0, 4);
              sendOSC('/live/clip/add/notes', track, 0, pitch, 0, 3.9, velocity, 0);
              sendOSC('/live/clip/set/looping', track, 0, 0);
              sendOSC('/live/clip/fire', track, 0);
              return;
            }

            // MIDI note off: stop the clip
            if (msg.type === 'note_off') {
              const { track } = msg as { track: number };
              sendOSC('/live/clip/stop', track, 0);
              return;
            }

            // Fist-gesture XYZ control: { hand, track, x, y, z }
            const { hand, track: msgTrack, x, y, z, volume } = msg as { hand: 'left' | 'right'; track: number; x: number; y: number; z: number; volume?: number };
            const track = (msgTrack !== undefined && msgTrack >= 0) ? msgTrack : (hand === 'left' ? 0 : 1);

            // No instrument selected — ignore gesture entirely
            if (msgTrack === undefined || msgTrack < 0) return;

            // X → panning (-1 to 1 maps directly)
            sendOSC('/live/track/set/panning', track, x);

            // Volume: use pre-computed absolute value when present, else derive from Y
            const absVolume = volume !== undefined ? volume : (y + 1) / 2;
            sendOSC('/live/track/set/volume', track, absVolume);
            trackVolumes.set(track, absVolume);
            broadcast(JSON.stringify({ type: 'volume_update', track, volume: absVolume }));

            // Z → send 0 level (remap -1..1 to 0..1)
            sendOSC('/live/track/set/send', track, 0, (z + 1) / 2);
          } catch (err) {
            console.error('\x1b[36m[osc-bridge]\x1b[0m message parse error:', err);
          }
        });

        ws.on('close', () => {
          console.log('\x1b[36m[osc-bridge]\x1b[0m client disconnected');
        });

        ws.on('error', (err) => {
          console.error('\x1b[36m[osc-bridge]\x1b[0m WebSocket error:', err.message);
        });
      });

      console.log(
        `\x1b[36m[osc-bridge]\x1b[0m ready — ws:/osc-bridge → AbletonOSC udp://${ABLETON_HOST}:${ABLETON_PORT}`,
      );
    },
  };
}
