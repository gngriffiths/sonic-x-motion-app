import {
  createSystem,
  DoubleSide,
  Entity,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
} from "@iwsdk/core";
import { InstrumentTag } from "./instrument-select.js";

const WS_URL = `wss://${window.location.host}/osc-bridge`;

const METER_W = 0.9;
// 512:96 canvas ratio used for proportions
const METER_H = METER_W * (96 / 512);
const ASPECT = METER_W / METER_H; // ≈ 5.333

const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = `
  uniform float uVolume;
  varying vec2 vUv;

  float roundedBoxSDF(vec2 p, vec2 b, float r) {
    vec2 d = abs(p) - b + r;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
  }

  void main() {
    float aspect = ${ASPECT.toFixed(4)};
    float cornerRadius = 0.09;
    float borderSize   = 0.055;

    // Map UV to aspect-corrected centered space
    vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
    float hw = aspect * 0.5;
    float hh = 0.5;

    // Outer rounded shape — anti-aliased edge
    float outerSDF = roundedBoxSDF(p, vec2(hw - cornerRadius, hh - cornerRadius), cornerRadius);
    float alpha = 1.0 - smoothstep(-0.02, 0.0, outerSDF);
    if (alpha < 0.01) discard;

    // Inner content area (excludes border)
    float innerR   = max(0.01, cornerRadius - borderSize);
    float innerSDF = roundedBoxSDF(p,
      vec2(hw - cornerRadius - borderSize, hh - cornerRadius - borderSize),
      innerR);

    vec3 color;
    if (innerSDF > 0.0) {
      // White border
      color = vec3(1.0);
    } else if (vUv.x <= uVolume) {
      // Left-to-right gradient fill: green → yellow → red
      float t = uVolume > 0.001 ? vUv.x / uVolume : 0.0;
      vec3 green  = vec3(0.133, 0.773, 0.369);
      vec3 yellow = vec3(0.918, 0.702, 0.031);
      vec3 red    = vec3(0.937, 0.267, 0.267);
      color = t < 0.6
        ? mix(green, yellow, t / 0.6)
        : mix(yellow, red, (t - 0.6) / 0.4);
    } else {
      // Dark background
      color = vec3(0.067, 0.094, 0.153);
    }

    gl_FragColor = vec4(color, alpha);
  }
`;

export class VolumeDisplaySystem extends createSystem({
  instruments: { required: [InstrumentTag] },
}) {
  private materials = new Map<number, ShaderMaterial>();
  private ws!: WebSocket;

  init() {
    const createMeter = (entity: Entity) => {
      const trackIndex = entity.getValue(InstrumentTag, 'trackIndex') as number;
      // Deduplicate — both the explicit iterate and subscribe may fire for the same entity
      if (this.materials.has(trackIndex)) return;

      const obj = entity.object3D!;
      const mat = new ShaderMaterial({
        uniforms: { uVolume: { value: 0.0 } },
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      });
      this.materials.set(trackIndex, mat);

      const mesh = new Mesh(new PlaneGeometry(METER_W, METER_H), mat);
      // Set position BEFORE createTransformEntity — the Transform component defaults to
      // [NaN,NaN,NaN] which causes attachToEntity to copy from mesh.position automatically.
      mesh.position.set(obj.position.x, obj.position.y - 0.7, obj.position.z);
      this.world.createTransformEntity(mesh, { parent: this.world.sceneEntity, persistent: true });
    };

    // Explicitly iterate existing entities — subscribe('qualify') may not fire
    // retroactively for entities that already matched when the system was registered.
    for (const entity of this.queries.instruments.entities) {
      createMeter(entity);
    }

    // Also subscribe for any future entities that gain InstrumentTag
    this.queries.instruments.subscribe('qualify', createMeter);

    this.ws = new WebSocket(WS_URL);
    this.ws.addEventListener('message', (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;
        if (msg.type === 'volume_update') {
          const mat = this.materials.get(msg.track as number);
          if (mat) mat.uniforms.uVolume.value = msg.volume as number;
        }
      } catch { /* ignore malformed messages */ }
    });

    this.cleanupFuncs.push(() => this.ws.close());
  }
}
