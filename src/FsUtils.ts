import { effectify } from "@effect/platform-node/Effectify"
import * as FileSystem from "@effect/platform-node/FileSystem"
import { Context, Effect, Layer } from "effect"
import { glob } from "glob"
import * as CP from "node:child_process"

const make = Effect.gen(function*(_) {
  const fs = yield* _(FileSystem.FileSystem)

  const exec = effectify(CP.exec)

  const globFiles = (pattern: string) =>
    Effect.tryPromise({
      try: () => glob(pattern),
      catch: e => new Error(`glob failed: ${e}`),
    })

  const modifyFile = (path: string, f: (s: string, path: string) => string) =>
    fs.readFileString(path).pipe(
      Effect.bindTo("original"),
      Effect.let("modified", ({ original }) => f(original, path)),
      Effect.flatMap(({ modified, original }) =>
        original === modified
          ? Effect.unit
          : fs.writeFile(path, new TextEncoder().encode(modified))
      ),
    )

  const modifyGlob = (
    pattern: string,
    f: (s: string, path: string) => string,
  ) =>
    globFiles(pattern).pipe(
      Effect.flatMap(paths =>
        Effect.forEach(paths, path => modifyFile(path, f), {
          concurrency: "inherit",
          discard: true,
        })
      ),
      Effect.withSpan("FsUtils.modifyGlob", { attributes: { pattern } }),
    )

  const copyIfExists = (from: string, to: string) =>
    fs.access(from).pipe(
      Effect.zipRight(fs.remove(to, { recursive: true })),
      Effect.zipRight(fs.copy(from, to, { overwrite: true })),
      Effect.catchTag("SystemError", e =>
        e.reason === "NotFound" ? Effect.unit : Effect.fail(e)),
      Effect.withSpan("FsUtils.copyIfExists", { attributes: { from, to } }),
    )

  const rmAndMkdir = (path: string) =>
    fs.remove(path, { recursive: true }).pipe(
      Effect.zipRight(fs.makeDirectory(path)),
    )

  return {
    exec,
    globFiles,
    modifyFile,
    modifyGlob,
    copyIfExists,
    rmAndMkdir,
  } as const
})

export interface FsUtils extends Effect.Effect.Success<typeof make> {}
export const FsUtils = Context.Tag<FsUtils>("@effect/build-tools/FsUtils")
export const FsUtilsLive = Layer.effect(FsUtils, make).pipe(
  Layer.use(FileSystem.layer),
)
