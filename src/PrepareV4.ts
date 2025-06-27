import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FileSystem } from "@effect/platform/FileSystem"
import { Path } from "@effect/platform/Path"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { FsUtils, FsUtilsLive } from "./FsUtils"

export const run = Effect.gen(function*() {
  const fs = yield* FileSystem
  const fsUtils = yield* FsUtils
  const path = yield* Path

  const process = Effect.fnUntraced(function*(template: string) {
    const directory = path.dirname(template)
    const content = (yield* fs.readFileString(path.join(template))).trim() +
      "\n\n"
    const modules = (yield* fs.readDirectory(directory)).map((_) =>
      path.basename(_)
    ).filter((path) =>
      path !== "index.ts" && path.endsWith(".ts") && !path.startsWith(".")
    ).sort((a, b) => a.localeCompare(b))
    const moduleContents = yield* Effect.forEach(
      modules,
      (file) => processModule(directory, file),
      { concurrency: "inherit" }
    )
    yield* fs.writeFileString(
      path.join(directory, "index.ts"),
      `${content}${moduleContents.join("\n\n")}\n`
    ).pipe(
      Effect.uninterruptible
    )
  }, Effect.ignore)

  const processModule = Effect.fnUntraced(function*(
    directory: string,
    file: string
  ) {
    const content = yield* fs.readFileString(path.join(directory, file))
    const topComment = content.match(/\/\*\*\n.+?\*\//s)?.[0] ?? ""
    const moduleName = file
      .slice(file.lastIndexOf("/") + 1)
      .slice(0, -path.extname(file).length)
    const srcFile = file
      .replace(/\.ts$/, ".js")
      .replace(/\.tsx$/, ".jsx")

    return `${topComment}\nexport * as ${moduleName} from "./${srcFile}"`
  })

  const templates = yield* fsUtils.glob("src/**/.index.ts")

  yield* Effect.forEach(
    templates,
    process,
    {
      concurrency: "inherit",
      discard: true
    }
  )
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      FsUtilsLive,
      NodeFileSystem.layer,
      NodePath.layerPosix
    )
  )
)
