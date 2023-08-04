import * as FileSystem from "@effect/platform-node/FileSystem"
import { Effect, Layer, pipe, ReadonlyArray } from "effect"
import { posix } from "node:path"
import { FsUtils, FsUtilsLive } from "./FsUtils"
import type { PackageJson } from "./PackageContext"
import { PackageContext, PackageContextLive } from "./PackageContext"

export const run = Effect.gen(function*(_) {
  const fsUtils = yield* _(FsUtils)
  const fs = yield* _(FileSystem.FileSystem)
  const ctx = yield* _(PackageContext)

  const mkDist = fsUtils.rmAndMkdir("./dist")
  const copyReadme = fs.copy("README.md", "./dist/README.md")
  const copyLicense = fs.copy("LICENSE", "./dist/LICENSE")
  const copyTsConfig = fsUtils.copyGlobCached(".", "tsconfig.*", "./dist")

  const copyMjs = fsUtils.copyIfExists("./build/mjs", "./dist/mjs")
  const copyCjs = fsUtils.copyGlobCached("./build/cjs", "**/*", "./dist")
  const copyDts = fsUtils.copyGlobCached("./build/dts", "**/*", "./dist")
  const copySrc = fsUtils.copyIfExists("./src", "./dist/src")
  const modifySourceMaps = fsUtils.modifyGlob("./dist/**/*.map", replace)

  const copySources = Effect.all([
    copyCjs,
    copyMjs,
    copyDts,
    copySrc,
  ], { concurrency: "inherit", discard: true }).pipe(
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
      sideEffects: [],
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
    addOptional("optionalDependencies")
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
    Effect.flatMap(_ => fs.writeFileString("./dist/package.json", _)),
  )

  // pack
  yield* _(mkDist)
  yield* _(
    Effect.all([
      copyReadme,
      copyLicense,
      copyTsConfig,
      writePackageJson,
      copySources,
    ], { concurrency: "inherit", discard: true }),
    Effect.withConcurrency(10),
  )
}).pipe(
  Effect.provideLayer(
    Layer.mergeAll(FileSystem.layer, FsUtilsLive, PackageContextLive),
  ),
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
