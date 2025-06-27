import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FileSystem } from "@effect/platform/FileSystem"
import { Path } from "@effect/platform/Path"
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

  const buildPackageJson = Effect.sync(() => {
    const out: Record<string, any> = {
      name: ctx.packageJson.name,
      version: ctx.packageJson.version,
      description: ctx.packageJson.description,
      license: ctx.packageJson.license,
      repository: ctx.packageJson.repository,
      sideEffects: [
        ...(ctx.hasCjs ? ["/dist/cjs/"] : []),
        ...(ctx.hasEsm ? ["/dist/esm/"] : [])
      ].flatMap((dir) =>
        ctx.packageJson.sideEffects.map((_) =>
          _.replace(".ts", ".js").replace(".tsx", ".js").replace("/src/", dir)
        )
      )
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
        executableFiles: ctx.packageJson.publishConfig.executableFiles
      }
    }

    if (Object.keys(ctx.entrypoints).length > 0) {
      const main = "." in ctx.entrypoints ? ctx.entrypoints["."] : undefined
      if (main !== undefined) {
        out.main = !main.ts
          ? main.stripped
          : `./dist/${ctx.hasCjs ? "cjs" : "esm"}/${main.stripped}.js`

        if (main.ts && ctx.hasEsm && ctx.hasCjs) {
          out.module = `./dist/esm/${main.stripped}.js`
        }

        if (main.ts && ctx.hasDts) {
          out.types = `./dist/dts/${main.stripped}.d.ts`
        }
      }

      out.exports = Record.fromEntries(
        Object.entries(ctx.entrypoints).map(([entry, module]) => {
          if (!module.ts) {
            return [entry, module.stripped]
          }

          return [entry, {
            types: `./dist/dts/${module.stripped}.d.ts`,
            import: `./dist/esm/${module.stripped}.js`,
            default: `./dist/cjs/${module.stripped}.js`
          }]
        })
      )

      out.typesVersions = {
        "*": Record.fromEntries(
          Object.entries(ctx.entrypoints)
            .filter(([entry, module]) => entry !== "." && module.ts)
            .map(([entry, module]) => [entry.replace(/^\.\//, ""), [
              `./dist/dts/${module.stripped}.d.ts`
            ]])
        )
      }
    }

    return out
  })

  const createProxies = Effect.forEach(
    Object.entries(ctx.entrypoints).filter(([entry, module]) =>
      entry !== "." && module.ts
    ),
    ([entry, module]) =>
      Effect.gen(function*() {
        yield* fsUtils.mkdirCached(`dist/${entry}`)

        const out: Record<string, any> = {
          sideEffects: []
        }

        out.main = path.relative(
          `dist/${entry}`,
          `dist/dist/${ctx.hasCjs ? "cjs" : "esm"}/${module.stripped}.js`
        )

        if (ctx.hasEsm && ctx.hasCjs) {
          out.module = path.relative(
            `dist/${entry}`,
            `dist/dist/esm/${module.stripped}.js`
          )
        }

        out.types = path.relative(
          `dist/${entry}`,
          `dist/dist/dts/${module.stripped}.d.ts`
        )

        yield* fsUtils.writeJson(`dist/${entry}/package.json`, out)
      }),
    {
      concurrency: "inherit",
      discard: true
    }
  )

  const writePackageJson = buildPackageJson.pipe(
    Effect.map((_) => JSON.stringify(_, null, 2)),
    Effect.flatMap((_) => fs.writeFileString("dist/package.json", _)),
    Effect.withSpan("Pack-v3/buildPackageJson")
  )

  const mkDist = fsUtils.rmAndMkdir("dist")
  const copyReadme = fs.copy("README.md", "dist/README.md")
  const copyLicense = fs.copy("LICENSE", "dist/LICENSE")

  const copyEsm = ctx.hasEsm
    ? fsUtils.rmAndCopy("build/esm", "dist/dist/esm").pipe(
      Effect.zipRight(fsUtils.writeJson("dist/dist/esm/package.json", {
        type: "module",
        sideEffects: ctx.packageJson.sideEffects.map((_) =>
          _.replace(".ts", ".js").replace("/src/", "/")
        )
      }))
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
      Effect.zipRight(fs.remove("dist/src/.index.ts").pipe(Effect.ignore))
    )
    : Effect.void

  const copySources = Effect.all([
    copyEsm,
    copyCjs,
    copyDts,
    copySrc
  ], { concurrency: "inherit", discard: true }).pipe(
    Effect.withSpan("Pack-v3/copySources")
  )

  yield* mkDist
  yield* Effect.all([
    writePackageJson,
    copyReadme,
    copyLicense,
    copySources,
    createProxies
  ], { concurrency: "inherit", discard: true }).pipe(
    Effect.withConcurrency(10)
  )
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      NodeFileSystem.layer,
      NodePath.layerPosix,
      FsUtilsLive,
      PackageContextLive
    )
  )
)
