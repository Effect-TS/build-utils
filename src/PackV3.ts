import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FileSystem } from "@effect/platform/FileSystem"
import { Path } from "@effect/platform/Path"
import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Record from "effect/Record"
import { FsUtils, FsUtilsLive } from "./FsUtils"
import type { PackageJson } from "./PackageContext"
import { PackageContext, PackageContextLive } from "./PackageContext"

export const run = Effect.gen(function*() {
  const fsUtils = yield* FsUtils
  const fs = yield* FileSystem
  const path = yield* Path
  const ctx = yield* PackageContext
  const modules = Object.entries(ctx.packageJson.exports ?? {}).map((
    [module, file],
  ) =>
    [module, file.replace(/^\.\/src\//, "").replace(/\.tsx?$/, "")] as [
      module: string,
      file: string,
    ]
  )

  const buildPackageJson = Effect.sync(() => {
    const out: Record<string, any> = {
      name: ctx.packageJson.name,
      version: ctx.packageJson.version,
      description: ctx.packageJson.description,
      license: ctx.packageJson.license,
      repository: ctx.packageJson.repository,
      sideEffects: [
        ...(ctx.hasCjs ? ["/dist/cjs/"] : []),
        ...(ctx.hasEsm ? ["/dist/esm/"] : []),
      ].flatMap(dir =>
        ctx.packageJson.sideEffects.map(_ =>
          _.replace(".ts", ".js").replace("/src/", dir)
        )
      ),
    }

    const addOptional = (key: keyof PackageJson) => {
      if (ctx.packageJson[key]) {
        out[key as string] = ctx.packageJson[key]
      }
    }

    addOptional("author")
    addOptional("homepage")
    addOptional("dependencies")
    addOptional("peerDependencies")
    addOptional("peerDependenciesMeta")
    addOptional("optionalDependencies")
    addOptional("gitHead")
    addOptional("bin")

    if (ctx.packageJson.publishConfig?.provenance === true) {
      out.publishConfig = { provenance: true }
    }

    if (
      ctx.packageJson.publishConfig?.executableFiles !== undefined
      && ctx.packageJson.publishConfig.executableFiles.length > 0
    ) {
      out.publishConfig = {
        ...out.publishConfig,
        executableFiles: ctx.packageJson.publishConfig.executableFiles,
      }
    }

    if (Array.length(modules) > 0) {
      const main = modules.find(([entry]) => entry === ".")?.[1]

      if (main !== undefined) {
        out.main = ctx.hasCjs
          ? `./dist/cjs/${main}.js`
          : `./dist/esm/${main}.js`

        if (ctx.hasEsm && ctx.hasCjs) {
          out.module = `./dist/esm/${main}.js`
        }

        if (ctx.hasDts) {
          out.types = `./dist/dts/${main}.d.ts`
        }
      }

      out.exports = Record.fromEntries(
        modules.map(([entry, file]) => {
          if (path.extname(entry) !== "") {
            return [entry, file]
          }

          return [entry, {
            types: `./dist/dts/${file}.d.ts`,
            import: `./dist/esm/${file}.js`,
            default: `./dist/cjs/${file}.js`,
          }]
        }),
      )

      out.typesVersions = {
        "*": Record.fromEntries(
          modules.map((
            [entry, file],
          ) => [entry, `./dist/dts/${file}.d.ts`]),
        ),
      }
    }

    return out
  })

  const createProxies = Effect.forEach(
    modules.filter(([entry]) => entry !== "." && path.extname(entry) === ""),
    ([entry, file]) =>
      fsUtils.mkdirCached(`dist/${entry}`).pipe(
        Effect.zipRight(fsUtils.writeJson(`dist/${entry}/package.json`, {
          main: path.relative(
            `dist/${entry}`,
            `dist/dist/${ctx.hasCjs ? "cjs" : "esm"}/${file}.js`,
          ),
          ...(ctx.hasEsm && ctx.hasCjs
            ? {
              module: path.relative(
                `dist/${entry}`,
                `dist/dist/esm/${file}.js`,
              ),
            }
            : {}),
          types: path.relative(`dist/${entry}`, `dist/dist/dts/${file}.d.ts`),
          sideEffects: [],
        })),
      ),
    {
      concurrency: "inherit",
      discard: true,
    },
  )

  const writePackageJson = buildPackageJson.pipe(
    Effect.map(_ => JSON.stringify(_, null, 2)),
    Effect.flatMap(_ => fs.writeFileString("dist/package.json", _)),
    Effect.withSpan("Pack-v3/buildPackageJson"),
  )

  const mkDist = fsUtils.rmAndMkdir("dist")
  const copyReadme = fs.copy("README.md", "dist/README.md")
  const copyLicense = fs.copy("LICENSE", "dist/LICENSE")

  const copyEsm = ctx.hasEsm
    ? fsUtils.rmAndCopy("build/esm", "dist/dist/esm").pipe(
      Effect.zipRight(fsUtils.writeJson("dist/dist/esm/package.json", {
        type: "module",
        sideEffects: ctx.packageJson.sideEffects.map(_ =>
          _.replace(".ts", ".js").replace("/src/", "/")
        ),
      })),
    )
    : Effect.void
  const copyCjs = ctx.hasCjs
    ? fsUtils.rmAndCopy("build/cjs", "dist/dist/cjs")
    : Effect.void
  const copyDts = ctx.hasDts
    ? fsUtils.rmAndCopy("build/dts", "dist/dist/dts")
    : Effect.void
  const copySrc = ctx.hasSrc
    ? fsUtils.rmAndCopy("src", "dist/src").pipe(
      Effect.zipRight(fs.remove("dist/src/.index.ts").pipe(Effect.ignore)),
    )
    : Effect.void

  const copySources = Effect.all([
    copyEsm,
    copyCjs,
    copyDts,
    copySrc,
  ], { concurrency: "inherit", discard: true }).pipe(
    Effect.withSpan("Pack-v3/copySources"),
  )

  yield* mkDist
  yield* Effect.all([
    writePackageJson,
    copyReadme,
    copyLicense,
    copySources,
    createProxies,
  ], { concurrency: "inherit", discard: true }).pipe(
    Effect.withConcurrency(10),
  )
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      NodeFileSystem.layer,
      NodePath.layerPosix,
      FsUtilsLive,
      PackageContextLive,
    ),
  ),
)
