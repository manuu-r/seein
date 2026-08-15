import { defineConfig } from "vite";

export default defineConfig({
  root: "renderer",
  base: "/viewer/",
  build: {
    outDir: "../dist/public/viewer",
    emptyOutDir: true,
  },
});
