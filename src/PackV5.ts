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
      sideEffects: ctx.packageJson.sideEffects.map((_) =>
        _.replace(".ts", ".js").replace(".tsx", ".js").replace(
          "/src/",
          "/dist/"
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
        out.main = `./dist/${main}.js`
        out.types = `./dist/${main}.d.ts`
      }

      out.exports = Record.fromEntries(
        Object.entries(entrypoints).map(([entry, module]) => {
          return [entry, {
            types: `./dist/${module}.d.ts`,
            default: `./dist/${module}.js`
          }]
        })
      )
    }

    return out
  })

  const writePackageJson = buildPackageJson.pipe(
    Effect.map((_) => JSON.stringify(_, null, 2)),
    Effect.flatMap((_) => fs.writeFileString("dist/package.json", _)),
    Effect.withSpan("Pack-v5/buildPackageJson")
  )

  const mkDist = fsUtils.rmAndMkdir("dist")
  const copyReadme = fs.copy("README.md", "dist/README.md")
  const copyLicense = fs.copy("LICENSE", "dist/LICENSE")

  const copyDist = fsUtils.rmAndCopy("build", "dist/dist")
  const copySrc = ctx.hasSrc
    ? fsUtils.rmAndCopy("src", "dist/src").pipe(
      Effect.zipRight(
        fsUtils.glob("dist/src/**/.index.ts").pipe(
          Effect.flatMap(Effect.forEach((_) => fs.remove(_)))
        )
      )
    )
    : Effect.void

  const copySources = Effect.all([
    copyDist,
    copySrc
  ], { concurrency: "inherit", discard: true }).pipe(
    Effect.withSpan("Pack-v5/copySources")
  )

  yield* mkDist
  yield* Effect.all([
    writePackageJson,
    copyReadme,
    copyLicense,
    copySources
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
