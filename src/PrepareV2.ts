import { FileSystem, Path } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { FsUtils, FsUtilsLive } from "./FsUtils"
import { PackageJson } from "./PackageContext"

export const run = Effect.gen(function*(_) {
  const fs = yield* _(FileSystem.FileSystem)
  const path = yield* _(Path.Path)
  const fsUtils = yield* _(FsUtils)

  const pkgRaw = yield* _(fsUtils.readJson("package.json"))
  const pkg = yield* _(PackageJson.parse(pkgRaw))
  const entrypoints = yield* _(
    fsUtils.glob(pkg.effect.generateIndex.include, {
      nodir: true,
      cwd: "src",
      ignore: [
        ...pkg.effect.generateIndex.exclude,
        "**/internal/**",
        "**/index.ts",
      ],
    }),
  )

  const modules = entrypoints
    .map(file => file.replace(/\.ts$/, ""))
    .sort()

  const template = yield* _(
    fs.readFileString("src/.index.ts"),
    Effect.map(_ => _.trim() + "\n\n"),
    Effect.orElseSucceed(() => ""),
  )

  const content = yield* _(
    Effect.forEach(
      modules,
      module =>
        Effect.gen(function*(_) {
          const content = yield* _(
            fs.readFileString(path.join("src", `${module}.ts`)),
          )
          const hasImpl = yield* _(
            fs.exists(path.join("src", "impl", `${module}.ts`)),
          )

          const topComment = content.match(/\/\*\*\n.+?\*\//s)?.[0] ?? ""

          if (hasImpl) {
            return `export {\n  ${
              topComment.split("\n").join("\n  ")
            }\n  ${module}\n} from "./${module}.js"`
          }

          return `${topComment}\nexport * as ${module} from "./${module}.js"`
        }),
      { concurrency: "inherit" },
    ),
  )

  const index = `${template}${content.join("\n\n")}\n`

  yield* _(
    fs.writeFileString("src/index.ts", index),
    Effect.uninterruptible,
  )
}).pipe(
  Effect.provide(
    Layer.mergeAll(FsUtilsLive, FileSystem.layer, Path.layerPosix),
  ),
)
