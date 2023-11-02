import { FileSystem, Path } from "@effect/platform-node"
import { Schema } from "@effect/schema"
import { Effect, Layer } from "effect"
import { FsUtils, FsUtilsLive } from "./FsUtils"

export const run = Effect.gen(function*(_) {
  const fs = yield* _(FileSystem.FileSystem)
  const path = yield* _(Path.Path)
  const fsUtils = yield* _(FsUtils)

  const pkgRaw = yield* _(fsUtils.readJson("package.json"))
  const pkg = yield* _(PackageJson.parse(pkgRaw))
  const entrypoints = yield* _(
    fsUtils.glob(pkg.effect.publicModules, {
      nodir: true,
      cwd: "src",
      ignore: ["**/internal/**", "**/index.ts"],
    }),
  )

  const modules = entrypoints
    .map(file => file.replace(/\.ts$/, ""))
    .sort()

  const exports: Record<string, any> = {
    "./package.json": "./package.json",
    ".": {
      types: "./dist/dts/index.d.ts",
      import: "./dist/esm/index.js",
      require: "./dist/cjs/index.js",
    },
  }

  modules.forEach(file => {
    exports[`./${file}`] = {
      types: `./dist/dts/${file}.d.ts`,
      import: `./dist/esm/${file}.js`,
      require: `./dist/cjs/${file}.js`,
    }
  })

  yield* _(
    fsUtils.writeJson("package.json", { ...pkgRaw, exports }),
    Effect.uninterruptible,
  )

  if (pkg.effect.generateIndex) {
    const template = yield* _(
      fs.readFileString("src/.index.ts"),
      Effect.map(_ => _.trim() + "\n\n"),
      Effect.orElseSucceed(() => ""),
    )

    const content = yield* _(
      Effect.forEach(
        modules,
        module =>
          Effect.map(
            fs.readFileString(path.join("src", `${module}.ts`)),
            content => {
              const topComment = content.match(/\/\*\*\n.+?\*\//s)?.[0] ?? ""
              return `${topComment}\nexport * as ${module} from "./${module}.js"`
            },
          ),
        { concurrency: "inherit" },
      ),
    )

    const index = `${template}${content.join("\n\n")}\n`

    yield* _(
      fs.writeFileString("src/index.ts", index),
      Effect.uninterruptible,
    )
  }
}).pipe(
  Effect.provide(
    Layer.mergeAll(FsUtilsLive, FileSystem.layer, Path.layerPosix),
  ),
)

class EffectConfig extends Schema.Class<EffectConfig>()({
  generateIndex: Schema.optional(Schema.boolean).withDefault(() => true),
  publicModules: Schema.optional(Schema.array(Schema.string)).withDefault(
    () => ["*.ts"],
  ),
}) {
  static readonly default = new EffectConfig({
    generateIndex: true,
    publicModules: ["*.ts"],
  })
}

class PackageJson extends Schema.Class<PackageJson>()({
  name: Schema.string,
  effect: Schema.optional(EffectConfig).withDefault(() => EffectConfig.default),
}) {
  static readonly parse = Schema.parse(this)
}
