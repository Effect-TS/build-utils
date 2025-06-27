import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FileSystem } from "@effect/platform/FileSystem"
import { Path } from "@effect/platform/Path"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { FsUtils, FsUtilsLive } from "./FsUtils"
import { PackageJson } from "./PackageContext"

export const run = Effect.gen(function*() {
  const fs = yield* FileSystem
  const path = yield* Path
  const fsUtils = yield* FsUtils

  const pkgRaw = yield* fsUtils.readJson("package.json")
  const pkg = yield* PackageJson.decode(pkgRaw)
  const entrypoints = yield* fsUtils.glob(pkg.effect.generateIndex.include, {
    nodir: true,
    cwd: "src",
    ignore: [
      ...pkg.effect.generateIndex.exclude,
      "**/internal/**",
      "**/index.ts"
    ]
  })

  const modules = entrypoints
    .map((file) => file.replace(/\\/, "/").replace(/\.ts$/, ""))
    .sort()

  const template = yield* fs.readFileString("src/.index.ts").pipe(
    Effect.map((_) => _.trim() + "\n\n"),
    Effect.orElseSucceed(() => "")
  )

  const content = yield* Effect.forEach(
    modules,
    (module) =>
      Effect.gen(function*(_) {
        const content = yield* _(
          fs.readFileString(path.join("src", `${module}.ts`))
        )
        const hasImpl = yield* _(
          fs.exists(path.join("src", "impl", `${module}.ts`))
        )

        const moduleName = module.slice(module.lastIndexOf("/") + 1)
        const topComment = content.match(/\/\*\*\n.+?\*\//s)?.[0] ?? ""

        if (hasImpl) {
          return `export {\n  ${
            topComment.split("\n").join("\n  ")
          }\n  ${moduleName}\n} from "./${module}.js"`
        }

        return `${topComment}\nexport * as ${moduleName} from "./${module}.js"`
      }),
    { concurrency: "inherit" }
  )

  const index = `${template}${content.join("\n\n")}\n`

  yield* fs.writeFileString("src/index.ts", index).pipe(
    Effect.uninterruptible
  )
}).pipe(
  Effect.provide(
    Layer.mergeAll(FsUtilsLive, NodeFileSystem.layer, NodePath.layerPosix)
  )
)
