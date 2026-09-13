import { defineConfig } from "vite-plus";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  base: "/yw4-save-converter/",
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    target: "es2020",
    outDir: "dist",
    assetsInlineLimit: 0,
  },
});
