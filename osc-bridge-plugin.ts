import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { Plugin } from 'vite';
import { WebSocketServer } from 'ws';
import { Client, Message } from 'node-osc';

const ABLETON_HOST = '127.0.0.1';
const ABLETON_PORT = 11000;

export function oscBridgePlugin(): Plugin {
  return {
    name: 'osc-bridge',
    configureServer(server) {
      const oscClient = new Client(ABLETON_HOST, ABLETON_PORT);
      const wss = new WebSocketServer({ noServer: true });

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

        ws.on('message', (data) => {
          try {
            const { hand, x, y, z } = JSON.parse(data.toString()) as {
              hand: 'left' | 'right';
              x: number;
              y: number;
              z: number;
            };

            const track = hand === 'left' ? 0 : 1;

            // X → panning (-1 to 1 maps directly)
            sendOSC('/live/track/set/panning', track, x);

            // Y → volume (remap -1..1 to 0..1)
            sendOSC('/live/track/set/volume', track, (y + 1) / 2);

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
