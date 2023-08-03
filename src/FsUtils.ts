import * as FileSystem from "@effect/platform-node/FileSystem"
import * as Path from "@effect/platform-node/Path"
import { Context, Effect, Layer } from "effect"
import { glob } from "glob"

const make = Effect.gen(function*(_) {
  const fs = yield* _(FileSystem.FileSystem)
  const path_ = yield* _(Path.Path)

  const globFiles = (pattern: string) =>
    Effect.tryPromise({
      try: () => glob(pattern, { nodir: true }),
      catch: e => new Error(`glob failed: ${e}`),
    }).pipe(
      Effect.withSpan("FsUtils.globFiles", { attributes: { pattern } }),
    )

  const modifyFile = (path: string, f: (s: string, path: string) => string) =>
    fs.readFileString(path).pipe(
      Effect.bindTo("original"),
      Effect.let("modified", ({ original }) => f(original, path)),
      Effect.flatMap(({ modified, original }) =>
        original === modified
          ? Effect.unit
          : fs.writeFile(path, new TextEncoder().encode(modified))
      ),
      Effect.withSpan("FsUtils.modifyFile", { attributes: { path } }),
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
      Effect.zipRight(Effect.ignore(fs.remove(to, { recursive: true }))),
      Effect.zipRight(fs.copy(from, to)),
      Effect.catchTag("SystemError", e =>
        e.reason === "NotFound" ? Effect.unit : Effect.fail(e)),
      Effect.withSpan("FsUtils.copyIfExists", { attributes: { from, to } }),
    )

  const mkdirCached_ = yield* _(
    Effect.cachedFunction((path: string) =>
      fs.makeDirectory(path, { recursive: true }).pipe(
        Effect.withSpan("FsUtils.mkdirCached", { attributes: { path } }),
      )
    ),
  )
  const mkdirCached = (path: string) => mkdirCached_(path_.resolve(path))

  const copyGlobCached = (baseDir: string, pattern: string, to: string) =>
    globFiles(path_.join(baseDir, pattern)).pipe(
      Effect.flatMap(
        Effect.forEach(path => {
          const dest = path_.join(to, path_.relative(baseDir, path))
          const destDir = path_.dirname(dest)
          return mkdirCached(destDir).pipe(
            Effect.zipRight(fs.copyFile(path, dest)),
          )
        }, { concurrency: "inherit", discard: true }),
      ),
      Effect.withSpan("FsUtils.copyGlobCached", {
        attributes: { baseDir, pattern, to },
      }),
    )

  const rmAndMkdir = (path: string) =>
    fs.remove(path, { recursive: true }).pipe(
      Effect.ignore,
      Effect.zipRight(mkdirCached(path)),
      Effect.withSpan("FsUtils.rmAndMkdir", { attributes: { path } }),
    )

  return {
    globFiles,
    modifyFile,
    modifyGlob,
    copyIfExists,
    rmAndMkdir,
    mkdirCached,
    copyGlobCached,
  } as const
})

export interface FsUtils extends Effect.Effect.Success<typeof make> {}
export const FsUtils = Context.Tag<FsUtils>("@effect/build-tools/FsUtils")
export const FsUtilsLive = Layer.effect(FsUtils, make).pipe(
  Layer.use(FileSystem.layer),
  Layer.use(Path.layerPosix),
)
