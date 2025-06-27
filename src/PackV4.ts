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

  const templates = yield* fsUtils.glob("src/**/.index.ts")
  const entrypoints: Record<string, string> = {}
  yield* Effect.forEach(
    templates,
    Effect.fnUntraced(function*(template) {
      const directory = path.dirname(template)
      const files = (yield* fs.readDirectory(directory)).map((_) =>
        path.basename(_)
      )
        .filter((path) => path.endsWith(".ts") && !path.startsWith(".")).sort((
          a,
          b
        ) => a.localeCompare(b)).map((file) =>
          path.relative(
            "src",
            path.join(directory, file)
          ).replace(/\.ts$/, "")
        )

      for (const file of files) {
        const isIndex = file.endsWith("index")
        const stripped = isIndex ? file.slice(0, -6) : file
        const withDot = stripped === "" ? "." : `./${stripped}`
        entrypoints[withDot] = file
      }
    }),
    { concurrency: "inherit", discard: true }
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

    if (Object.keys(entrypoints).length > 0) {
      const main = "." in entrypoints ? entrypoints["."] : undefined
      if (main !== undefined) {
        out.main = `./dist/${ctx.hasCjs ? "cjs" : "esm"}/${main}.js`

        if (ctx.hasEsm && ctx.hasCjs) {
          out.module = `./dist/esm/${main}.js`
        }

        if (ctx.hasDts) {
          out.types = `./dist/dts/${main}.d.ts`
        }
      }

      out.exports = Record.fromEntries(
        Object.entries(entrypoints).map(([entry, module]) => {
          return [entry, {
            types: `./dist/dts/${module}.d.ts`,
            import: `./dist/esm/${module}.js`,
            default: `./dist/cjs/${module}.js`
          }]
        })
      )

      out.typesVersions = {
        "*": Record.fromEntries(
          Object.entries(entrypoints)
            .filter(([entry]) => entry !== ".")
            .map(([entry, module]) => [entry.replace(/^\.\//, ""), [
              `./dist/dts/${module}.d.ts`
            ]])
        )
      }
    }

    return out
  })

  const createProxies = Effect.forEach(
    Object.entries(entrypoints).filter(([entry]) => entry !== "."),
    ([entry, module]) =>
      Effect.gen(function*() {
        yield* fsUtils.mkdirCached(`dist/${entry}`)

        const out: Record<string, any> = {
          sideEffects: []
        }

        out.main = path.relative(
          `dist/${entry}`,
          `dist/dist/${ctx.hasCjs ? "cjs" : "esm"}/${module}.js`
        )

        if (ctx.hasEsm && ctx.hasCjs) {
          out.module = path.relative(
            `dist/${entry}`,
            `dist/dist/esm/${module}.js`
          )
        }

        out.types = path.relative(
          `dist/${entry}`,
          `dist/dist/dts/${module}.d.ts`
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
    Effect.withSpan("Pack-v4/buildPackageJson")
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
    Effect.withSpan("Pack-v4/copySources")
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
