import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FileSystem } from "@effect/platform/FileSystem"
import { Path } from "@effect/platform/Path"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import micromatch from "micromatch"
import { FsUtilsLive } from "./FsUtils"
import { PackageContext, PackageContextLive } from "./PackageContext"

export const run = Effect.gen(function*() {
  const fs = yield* FileSystem
  const path = yield* Path
  const ctx = yield* PackageContext

  const template = yield* fs.readFileString("src/.index.ts").pipe(
    Effect.map(_ => _.trim() + "\n\n"),
    Effect.orElseSucceed(() => ""),
  )

  const modules = Object.entries(ctx.entrypoints)
    .filter(([entry, module]) => module.ts && entry !== ".")
    .map(([, module]) => module.original.replace(/^\.\/src\//, ""))
    .filter((current, index, array) => array.indexOf(current) === index)

  const matches = micromatch(modules, [
    "*.ts",
    ...ctx.packageJson.effect.generateIndex.include,
  ], {
    ignore: [
      ...ctx.packageJson.effect.generateIndex.exclude,
      "**/internal/**",
      "**/index.ts",
    ],
  })

  const content = yield* Effect.forEach(
    matches,
    file =>
      Effect.gen(function*() {
        const content = yield* fs.readFileString(`./src/${file}`)
        const topComment = content.match(/\/\*\*\n.+?\*\//s)?.[0] ?? ""
        const moduleName = file
          .slice(file.lastIndexOf("/") + 1)
          .slice(0, -path.extname(file).length)
        const srcFile = file
          .replace(/\.ts$/, ".js")
          .replace(/\.tsx$/, ".jsx")

        return `${topComment}\nexport * as ${moduleName} from "./${srcFile}"`
      }),
    { concurrency: "inherit" },
  )

  const index = `${template}${content.join("\n\n")}\n`

  yield* fs.writeFileString("src/index.ts", index).pipe(
    Effect.uninterruptible,
  )
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      FsUtilsLive,
      PackageContextLive,
      NodeFileSystem.layer,
      NodePath.layerPosix,
    ),
  ),
)
