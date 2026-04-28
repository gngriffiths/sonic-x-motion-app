import {
  AssetManifest,
  AssetType,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SessionMode,
  SRGBColorSpace,
  AssetManager,
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