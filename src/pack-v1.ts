import * as FileSystem from "@effect/platform-node/FileSystem"
import { runMain } from "@effect/platform-node/Runtime"
import { Effect, Layer, pipe, ReadonlyArray } from "effect"
import { posix } from "node:path"
import { FsUtils, FsUtilsLive } from "./FsUtils"
import type { PackageJson } from "./PackageContext"
import { PackageContext, PackageContextLive } from "./PackageContext"

Effect.gen(function*(_) {
  const fsUtils = yield* _(FsUtils)
  const fs = yield* _(FileSystem.FileSystem)
  const ctx = yield* _(PackageContext)

  const mkDist = fsUtils.rmAndMkdir("./dist")
  const copyReadme = fs.copy("README.md", "./dist/README.md")
  const copyTsConfig = fsUtils.cp("./tsconfig.*", "./dist")

  const copyCjs = fsUtils.copyIfExists("./build/cjs", "./dist")
  const copyMjs = fsUtils.copyIfExists("./build/mjs", "./dist/mjs")
  const copyDts = fsUtils.copyIfExists("./build/dts", "./dist")
  const copySrc = fsUtils.copyIfExists("./src", "./dist/src")
  const modifySourceMaps = fsUtils.modifyGlob("./dist/**/*.map", replace)

  const copySources = Effect.all([
    copyCjs,
    copyMjs,
    copyDts,
    copySrc,
  ], { concurrency: "inherit" }).pipe(
    Effect.zipRight(modifySourceMaps),
    Effect.withSpan("Pack-v1/copySources"),
  )

  const buildPackageJson = Effect.sync(() => {
    const out: Record<string, any> = {
      name: ctx.packageJson.name,
      version: ctx.packageJson.version,
      description: ctx.packageJson.description,
      license: ctx.packageJson.license,
      repository: ctx.packageJson.repository,
      publishConfig: {
        access: "public",
      },
      exports: {
        "./*": {
          import: {
            types: "./*.d.ts",
            default: "./mjs/*.mjs",
          },
          require: {
            types: "./*.d.ts",
            default: "./*.js",
          },
        },
      },
    }
    const addOptional = (key: keyof PackageJson) => {
      if (ctx.packageJson[key]) {
        out[key as string] = ctx.packageJson[key]
      }
    }
    addOptional("author")
    addOptional("dependencies")
    addOptional("peerDependencies")
    addOptional("peerDependenciesMeta")
    addOptional("gitHead")
    addOptional("bin")

    if (ctx.hasMain) {
      out.exports["."] = {}

      if (ctx.hasMainMjs) {
        out.main = "./mjs/index.mjs"
        out.exports["."].import = {
          types: `./index.d.ts`,
          default: `./mjs/index.mjs`,
        }
      }
      if (ctx.hasMainCjs) {
        out.main = "./index.js"
        out.exports["."].require = {
          types: `./index.d.ts`,
          default: `./index.js`,
        }
      }
    }

    return out
  })

  const writePackageJson = buildPackageJson.pipe(
    Effect.map(_ => JSON.stringify(_, null, 2)),
    Effect.flatMap(_ =>
      fs.writeFile("./dist/package.json", new TextEncoder().encode(_))
    ),
  )

  // pack
  yield* _(mkDist)

  yield* _(
    Effect.all([
      copyReadme,
      copyTsConfig,
      writePackageJson,
      copySources,
    ]),
  )
}).pipe(
  Effect.provideLayer(
    Layer.mergeAll(FileSystem.layer, FsUtilsLive, PackageContextLive),
  ),
  Effect.tapErrorCause(Effect.logError),
  runMain,
)

// ==== utils

const replace = (content: string, path: string): string =>
  JSON.stringify(
    pipe(
      Object.entries(JSON.parse(content)),
      ReadonlyArray.map(([k, v]) =>
        k === "sources"
          ? ([
            k,
            ReadonlyArray.map(v as Array<string>, replaceString(path)),
          ] as const)
          : ([k, v] as const)
      ),
      ReadonlyArray.reduce({}, (acc, [k, v]) => ({ ...acc, [k]: v })),
    ),
  )

const replaceString = (path: string) => {
  const dir = posix.dirname(path)
  const patch: (x: string) => string = path.startsWith("dist/mjs/")
    ? x => x.replace(/(.*)\.\.\/src(.*)/gm, "$1src$2")
    : x => x.replace(/(.*)\.\.\/\.\.\/src(.*)/gm, "$1src$2")
  return (content: string) =>
    pipe(
      patch(content),
      x => posix.relative(dir, posix.join(dir, x)),
      x => (x.startsWith(".") ? x : "./" + x),
    )
}