import { FileSystem, Path } from "@effect/platform-node"
import {
  Effect,
  Layer,
  Order,
  pipe,
  ReadonlyArray,
  ReadonlyRecord,
  String,
} from "effect"
import { posix } from "node:path"
import { FsUtils, FsUtilsLive } from "./FsUtils"
import type { PackageJson } from "./PackageContext"
import { PackageContext, PackageContextLive } from "./PackageContext"

export const run = Effect.gen(function*(_) {
  const fsUtils = yield* _(FsUtils)
  const fs = yield* _(FileSystem.FileSystem)
  const ctx = yield* _(PackageContext)

  const modules = yield* _(
    fsUtils.glob(ctx.packageJson.effect.generateExports.include, {
      nodir: true,
      cwd: "src",
      ignore: [
        ...ctx.packageJson.effect.generateExports.exclude,
        "**/internal/**",
        "**/index.ts",
      ],
    }),
    Effect.map(ReadonlyArray.map(String.replace(/\.ts$/, ""))),
    Effect.map(ReadonlyArray.sort(Order.string)),
    Effect.withSpan("Pack-v2/discoverModules"),
  )

  const buildPackageJson = Effect.sync(() => {
    const out: Record<string, any> = {
      name: ctx.packageJson.name,
      version: ctx.packageJson.version,
      description: ctx.packageJson.description,
      license: ctx.packageJson.license,
      repository: ctx.packageJson.repository,
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

    if (ctx.hasMainCjs) {
      out.main = "./index.js"
    }

    if (ctx.hasMainEsm) {
      out.module = "./dist/esm/index.js"
    }

    if (ctx.hasMain && ctx.hasDts) {
      out.types = "./dist/dts/index.d.ts"
    }

    out.exports = {
      "./package.json": "./package.json",
    }

    if (ctx.hasMain) {
      out.exports["."] = {
        ...(ctx.hasDts && { types: "./dist/dts/index.d.ts" }),
        ...(ctx.hasMainEsm && { import: "./dist/esm/index.js" }),
        ...(ctx.hasMainCjs && { default: "./index.js" }),
      }
    }

    if (ReadonlyArray.length(modules) > 0) {
      out.exports = {
        ...out.exports,
        ...ReadonlyRecord.fromEntries(modules.map(_ => {
          const conditions = {
            ...(ctx.hasDts && { types: `./dist/dts/${_}.d.ts` }),
            ...(ctx.hasEsm && { import: `./dist/esm/${_}.js` }),
            ...(ctx.hasCjs && { default: `./${_}.js` }),
          }

          return [`./${_}`, conditions]
        })),
      }

      out.typesVersions = {
        "*": ReadonlyRecord.fromEntries(
          modules.map(_ => [_, [`./dist/dts/${_}.d.ts`]]),
        ),
      }
    }

    return out
  })

  const writePackageJson = buildPackageJson.pipe(
    Effect.map(_ => JSON.stringify(_, null, 2)),
    Effect.flatMap(_ => fs.writeFileString("dist/package.json", _)),
    Effect.withSpan("Pack-v2/buildPackageJson"),
  )

  const mkDist = fsUtils.rmAndMkdir("dist")
  const copyReadme = fs.copy("README.md", "dist/README.md")
  const copyLicense = fs.copy("LICENSE", "dist/LICENSE")

  const copyEsm = ctx.hasEsm
    ? fsUtils.rmAndCopy("build/esm", "dist/dist/esm").pipe(
      Effect.zipRight(fsUtils.writeJson("dist/dist/esm/package.json", {
        type: "module",
        sideEffects: [],
      })),
    )
    : Effect.unit
  const copyCjs = ctx.hasCjs
    ? fsUtils.copyGlobCached("build/cjs", "**/*", "dist")
    : Effect.unit
  const copyDts = ctx.hasDts
    ? fsUtils.rmAndCopy("build/dts", "dist/dist/dts")
    : Effect.unit
  const copySrc = ctx.hasSrc
    ? fsUtils.rmAndCopy("src", "dist/src").pipe(
      Effect.zipRight(fs.remove("dist/src/.index.ts").pipe(Effect.ignore)),
    )
    : Effect.unit
  const modifyCjsSourceMaps = fsUtils.modifyGlob(
    "dist/**/*.map",
    replace,
    { ignore: ["dist/dist/**"] },
  )

  const copySources = Effect.all([
    copyEsm,
    copyCjs,
    copyDts,
    copySrc,
  ], { concurrency: "inherit", discard: true }).pipe(
    Effect.zipRight(modifyCjsSourceMaps),
    Effect.withSpan("Pack-v2/copySources"),
  )

  yield* _(mkDist)
  yield* _(
    Effect.all([
      writePackageJson,
      copyReadme,
      copyLicense,
      copySources,
    ], { concurrency: "inherit", discard: true }),
    Effect.withConcurrency(10),
  )
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      FileSystem.layer,
      Path.layerPosix,
      FsUtilsLive,
      PackageContextLive,
    ),
  ),
)

// ==== utils

export const replace = (content: string, path: string): string =>
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
  const patch: (x: string) => string = x =>
    x.replace(/(.*)\.\.\/\.\.\/src(.*)/gm, "$1src$2")
  return (content: string) =>
    pipe(
      patch(content),
      x => posix.relative(dir, posix.join(dir, x)),
      x => (x.startsWith(".") ? x : "./" + x),
    )
}
