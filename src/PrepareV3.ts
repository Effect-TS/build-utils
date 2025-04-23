import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FileSystem } from "@effect/platform/FileSystem"
import { Path } from "@effect/platform/Path"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
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

  const modules = Object.entries(ctx.packageJson.exports ?? {}).filter((
    [module],
  ) => module !== "." && path.extname(module) === "")

  const content = yield* Effect.forEach(
    modules,
    ([module, file]) =>
      Effect.gen(function*(_) {
        const content = yield* _(fs.readFileString(file))
        const moduleName = module.slice(module.lastIndexOf("/") + 1)
        const topComment = content.match(/\/\*\*\n.+?\*\//s)?.[0] ?? ""
        const srcFile = file
          .replace("/src/", "/")
          .replace(/\.ts$/, ".js")
          .replace(/^\.tsx$/, ".jsx")

        return `${topComment}\nexport * as ${moduleName} from "${srcFile}"`
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
