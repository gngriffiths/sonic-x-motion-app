import {
  createSystem,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from "@iwsdk/core";

/** Movement range in metres from pinch origin that maps to +/-1.0 on each axis. */
const RANGE_M = 0.5;

/** WebSocket URL -- derived from window.location so it works both on the local
 *  browser (localhost) and on a Meta Quest connected via LAN (PC's IP address). */
const WS_URL = `wss://${window.location.host}/osc-bridge`;

export class PinchSphereSystem extends createSystem({}) {
  private leftSphere!: Mesh;
  private rightSphere!: Mesh;

  /** Pre-allocated scratch vectors -- no allocations in update(). */
  private pos!: Vector3;
  private leftOrigin!: Vector3;
  private rightOrigin!: Vector3;
  private delta!: Vector3;

  private leftPinching = false;
  private rightPinching = false;

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
      console.log('[PinchSphereSystem] OSC bridge connected'),
    );
    this.ws.addEventListener('error', (e) =>
      console.warn('[PinchSphereSystem] OSC bridge error', e),
    );

    this.cleanupFuncs.push(() => this.ws.close());
  }

  private sendOSC(hand: 'left' | 'right', x: number, y: number, z: number): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ hand, x, y, z }));
  }

  update() {
    // -- Left hand
    const leftGamepad = this.input.gamepads.left;
    const leftSelecting = leftGamepad?.getSelecting() ?? false;

    if (leftSelecting) {
      this.player.indexTipSpaces.left.getWorldPosition(this.pos);

      if (!this.leftPinching) {
        this.leftOrigin.copy(this.pos);
      }

      this.leftSphere.position.copy(this.pos);
      this.leftSphere.visible = true;

      this.delta.subVectors(this.pos, this.leftOrigin).divideScalar(RANGE_M);
      this.sendOSC(
        'left',
        Math.max(-1, Math.min(1, this.delta.x)),
        Math.max(-1, Math.min(1, this.delta.y)),
        Math.max(-1, Math.min(1, this.delta.z)),
      );
    } else {
      if (this.leftPinching) {
        this.sendOSC('left', 0, 0, 0);
      }
      this.leftSphere.visible = false;
    }
    this.leftPinching = leftSelecting;

    // -- Right hand
    const rightGamepad = this.input.gamepads.right;
    const rightSelecting = rightGamepad?.getSelecting() ?? false;

    if (rightSelecting) {
      this.player.indexTipSpaces.right.getWorldPosition(this.pos);

      if (!this.rightPinching) {
        this.rightOrigin.copy(this.pos);
      }

      this.rightSphere.position.copy(this.pos);
      this.rightSphere.visible = true;

      this.delta.subVectors(this.pos, this.rightOrigin).divideScalar(RANGE_M);
      this.sendOSC(
        'right',
        Math.max(-1, Math.min(1, this.delta.x)),
        Math.max(-1, Math.min(1, this.delta.y)),
        Math.max(-1, Math.min(1, this.delta.z)),
      );
    } else {
      if (this.rightPinching) {
        this.sendOSC('right', 0, 0, 0);
      }
      this.rightSphere.visible = false;
    }
    this.rightPinching = rightSelecting;
  }
}
