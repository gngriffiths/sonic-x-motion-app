import {
  AssetManifest,
  AssetType,
  BackSide,
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SessionMode,
  SRGBColorSpace,
  AssetManager,
  VisibilityState,
  World,
  BoxGeometry,
  SphereGeometry,
  MeshStandardMaterial,
} from "@iwsdk/core";

import { PanelSystem } from "./panel.js";
import { PinchSphereSystem } from "./pinch-sphere.js";

const assets: AssetManifest = {
  chimeSound: {
    url: "/audio/chime.mp3",
    type: AssetType.Audio,
    priority: "background",
  },
  webxr: {
    url: "/textures/webxr.png",
    type: AssetType.Texture,
    priority: "critical",
  },
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

  const webxrLogoTexture = AssetManager.getTexture("webxr")!;
  webxrLogoTexture.colorSpace = SRGBColorSpace;
  const logoBanner = new Mesh(
    new PlaneGeometry(3.39, 0.96),
    new MeshBasicMaterial({
      map: webxrLogoTexture,
      transparent: true,
    }),
  );
  world.createTransformEntity(logoBanner);
  logoBanner.position.set(0, 1, 1.8);
  logoBanner.rotateY(Math.PI);

// Create a red cube
   const cubeGeometry = new BoxGeometry(1, 1, 1);
   const redMaterial = new MeshStandardMaterial({ color: 0xff3333 });
   const cube = new Mesh(cubeGeometry, redMaterial);
   cube.position.set(-1, 0, -2);
   const cubeEntity = world.createTransformEntity(cube);

   // Create a green sphere
   const sphereGeometry = new SphereGeometry(0.5, 32, 32);
   const greenMaterial = new MeshStandardMaterial({ color: 0x33ff33 });
   const sphere = new Mesh(sphereGeometry, greenMaterial);
   sphere.position.set(1, 0, -2);
   const sphereEntity = world.createTransformEntity(sphere);

   // Create a blue floor plane
   const floorGeometry = new PlaneGeometry(4, 4);
   const blueMaterial = new MeshStandardMaterial({ color: 0x3333ff });
   const floor = new Mesh(floorGeometry, blueMaterial);
   floor.position.set(0, -1, -2);
   floor.rotation.x = -Math.PI / 2; // Rotate to be horizontal
   const floorEntity = world.createTransformEntity(floor);

  world.registerSystem(PanelSystem).registerSystem(PinchSphereSystem);
});