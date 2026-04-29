import {
  AssetManifest,
  AssetType,
  BackSide,
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  RayInteractable,
  SessionMode,
  AssetManager,
  VisibilityState,
  World,
  BoxGeometry,
} from "@iwsdk/core";

import { PanelSystem } from "./panel.js";
import { PinchSphereSystem } from "./fist-control-gesture.js";
import { InstrumentTag, InstrumentSelectSystem } from "./instrument-select.js";

const assets: AssetManifest = {
  chimeSound: {
    url: "/audio/chime.mp3",
    type: AssetType.Audio,
    priority: "background",
  },
  bass: { url: "/gltf/instruments/bass.glb", type: AssetType.GLTF },
  drums: { url: "/gltf/instruments/drums.glb", type: AssetType.GLTF },
  keyboard: { url: "/gltf/instruments/keyboard.glb", type: AssetType.GLTF },
};

function createGridTexture(): CanvasTexture {
  const size = 2048;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Gradient: very dark purple at bottom, white at top
  const grad = ctx.createLinearGradient(0, size, 0, 0);
  grad.addColorStop(0, '#0e0018');
  grad.addColorStop(0.45, '#3d0d6b');
  grad.addColorStop(1, '#ffffff');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Fine grid lines — medium purple, visible on both dark and light areas
  const spacing = 32;
  ctx.strokeStyle = 'rgba(150, 70, 220, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= size; x += spacing) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, size);
  }
  for (let y = 0; y <= size; y += spacing) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(size, y + 0.5);
  }
  ctx.stroke();

  return new CanvasTexture(canvas);
}

World.create(document.getElementById("scene-container") as HTMLDivElement, {
  assets,
  xr: {
    sessionMode: SessionMode.ImmersiveAR,
    offer: "always",
    features: {
      handTracking: { required: false },
      anchors: { required: false },
      hitTest: { required: false },
      planeDetection: { required: false },
      meshDetection: { required: false },
      layers: { required: false }, 
    },
  },
  features: {
    locomotion: true,
    grabbing: true,
    physics: true,
    sceneUnderstanding: true,
    environmentRaycast: true,
  },
}).then((world) => {
  const { camera } = world;

  camera.position.set(0, 1, 0.5);

  // Fallback environment for non-AR (browser) mode
  const gridBox = new Mesh(
    new BoxGeometry(20, 10, 20),
    new MeshBasicMaterial({ map: createGridTexture(), side: BackSide }),
  );
  gridBox.position.set(0, 4, 0); // bottom at y=-1, top at y=9
  world.createTransformEntity(gridBox, { parent: world.sceneEntity, persistent: true });
  world.visibilityState.subscribe((state) => {
    gridBox.visible = state === VisibilityState.NonImmersive;
  });

  // Place instruments in an arc at head height
  const drumsGltf = AssetManager.getGLTF('drums')!;
  drumsGltf.scene.position.set(-2, 1.6, -2);
  drumsGltf.scene.rotation.y = Math.PI / 4;
  const drumsEntity = world.createTransformEntity(drumsGltf.scene);
  drumsEntity.addComponent(RayInteractable);
  drumsEntity.addComponent(InstrumentTag, { trackIndex: 0 });

  const bassGltf = AssetManager.getGLTF('bass')!;
  bassGltf.scene.position.set(0, 1.6, -2.5);
  const bassEntity = world.createTransformEntity(bassGltf.scene);
  bassEntity.addComponent(RayInteractable);
  bassEntity.addComponent(InstrumentTag, { trackIndex: 1 });

  const keyboardGltf = AssetManager.getGLTF('keyboard')!;
  keyboardGltf.scene.position.set(2, 1.6, -2);
  keyboardGltf.scene.rotation.y = -Math.PI / 8;
  const keyboardEntity = world.createTransformEntity(keyboardGltf.scene);
  keyboardEntity.addComponent(RayInteractable);
  keyboardEntity.addComponent(InstrumentTag, { trackIndex: 2 });

  world.registerSystem(PanelSystem).registerSystem(PinchSphereSystem).registerSystem(InstrumentSelectSystem);
});