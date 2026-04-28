import { Client, Message } from 'node-osc';

const ABLETON_HOST = '127.0.0.1';
const ABLETON_PORT = 11000;

/** Ableton 0-based track indices to initialise. */
const TRACKS = [
  { name: 'drums',    index: 0 },
  { name: 'bass',     index: 1 },
  { name: 'keyboard', index: 2 },
];

const INITIAL_VOLUME = 0; // 0 = silent

const osc = new Client(ABLETON_HOST, ABLETON_PORT);

function sendOSC(address: string, ...args: Array<string | number>): void {
  const msg = new Message(address);
  for (const arg of args) msg.append(arg);
  osc.send(msg, (err?: Error | null) => {
    if (err) console.error(`[init-ableton] Error sending ${address}:`, err.message);
  });
}

for (const track of TRACKS) {
  sendOSC('/live/track/set/volume', track.index, INITIAL_VOLUME);
  console.log(`[init-ableton] ${track.name} (track ${track.index + 1}) volume → ${INITIAL_VOLUME}`);
}

// Give OSC messages time to be sent before closing
setTimeout(() => {
  osc.close();
  console.log('[init-ableton] Done.');
}, 200);
