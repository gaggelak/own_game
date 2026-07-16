import { defineConfig } from "vite";

// This config file runs in Node, but the project ships no @types/node (nothing
// else here needs them) — so declare just the bit we read.
declare const process: { env: Record<string, string | undefined> };

// Vite config tuned for both browser dev and Tauri.
// Tauri expects a fixed port and a non-cleared console: with no PORT in the
// environment we hold 1420 strictly, exactly as `npm run tauri dev` requires.
// Setting PORT hands the choice to the caller instead, so a second dev server
// can run alongside the first without fighting over the port.
const envPort = Number(process.env.PORT) || 0;
export default defineConfig({
  clearScreen: false,
  server: {
    port: envPort || 1420,
    strictPort: !envPort,
    host: "localhost",
  },
  // Rapier ships a WASM module; esnext target avoids transpiling away
  // top-level features the bundler relies on.
  build: {
    target: "esnext",
  },
});
