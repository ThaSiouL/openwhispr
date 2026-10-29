import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: "dist/wayland-overlay",
    assetsDir: "assets",
    rolldownOptions: {
      input: fileURLToPath(new URL("./wayland-overlay.html", import.meta.url)),
    },
  },
});
