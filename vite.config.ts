import { iwsdkDev } from "@iwsdk/vite-plugin-dev";

import {
  discoverComponents,
  generateGLXF,
} from "@iwsdk/vite-plugin-metaspatial";

import { compileUIKit } from "@iwsdk/vite-plugin-uikitml";
import { defineConfig } from "vite";
import mkcert from "vite-plugin-mkcert";
import { oscBridgePlugin } from "./osc-bridge-plugin.js";

export default defineConfig(({ command }) => ({
  plugins: [
    ...(command === "serve" ? [mkcert(), oscBridgePlugin()] : []),
    iwsdkDev({
      emulator: {
        device: "metaQuest3",
        environment: "living_room",
      },
      ai: { tools: ["copilot"] },
      verbose: true,
    }),

    discoverComponents({
      outputDir: "metaspatial/components",
      include: /\.(js|ts|jsx|tsx)$/,
      exclude: /node_modules/,
      verbose: false,
    }),
    generateGLXF({
      metaSpatialDir: "metaspatial",
      outputDir: "public/glxf",
      verbose: false,
      enableWatcher: true,
    }),

    compileUIKit({ sourceDir: "ui", outputDir: "public/ui", verbose: true }),
  ],
  server: { host: "0.0.0.0", port: 8081, open: true },
  build: {
    outDir: "dist",
    sourcemap: process.env.NODE_ENV !== "production",
    target: "esnext",
    rollupOptions: { input: "./index.html" },
  },
  esbuild: { target: "esnext" },
  optimizeDeps: {
    exclude: ["@babylonjs/havok"],
    esbuildOptions: { target: "esnext" },
  },
  publicDir: "public",
  base: "./",
}));
