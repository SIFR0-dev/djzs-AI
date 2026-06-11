import { defineConfig } from "vitest/config";
import path from "path";

const root = import.meta.dirname;

// Standalone vitest config. The app's vite.config.ts sets root to client/,
// which makes vitest miss tests in shared/ and server/. This config scopes
// test discovery to the TypeScript test locations and keeps path aliases.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(root, "client", "src"),
      "@shared": path.resolve(root, "shared"),
      "@assets": path.resolve(root, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: [
      "shared/**/*.{test,spec}.ts",
      "server/**/*.{test,spec}.ts",
      "tests/**/*.{test,spec}.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.cjs", "contracts/**"],
    passWithNoTests: true,
  },
});
