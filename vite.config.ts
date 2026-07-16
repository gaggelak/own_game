import { defineConfig } from "vite";

// Vite config tuned for both browser dev and Tauri.
// Tauri expects a fixed port and a non-cleared console.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "localhost",
  },
  // Rapier ships a WASM module; esnext target avoids transpiling away
  // top-level features the bundler relies on.
  build: {
    target: "esnext",
  },
});
