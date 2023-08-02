import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/pack-v1.ts"],
  clean: true,
  publicDir: true,
  noExternal: [/.*/],
})
