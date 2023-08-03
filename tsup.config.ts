import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/main.ts"],
  clean: true,
  publicDir: true,
  noExternal: [/.*/],
  treeshake: "smallest",
})
