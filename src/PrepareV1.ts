import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FileSystem } from "@effect/platform/FileSystem"
import { Path } from "@effect/platform/Path"
import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { FsUtils, FsUtilsLive } from "./FsUtils"

const defaultGitignoreTemplate = `coverage/
*.tsbuildinfo
node_modules/
.ultra.cache.json
.DS_Store
tmp/
build/
dist/
.direnv/`

export const run = Effect.gen(function*(_) {
  const fs = yield* _(FileSystem)
  const path_ = yield* _(Path)
  const fsUtils = yield* _(FsUtils)

  const topPackageJsonRaw = yield* _(fsUtils.readJson("./package.json"))
  const topPackageJson = yield* _(PackageJson.decode(topPackageJsonRaw))

  const tsConfig = yield* _(
    fsUtils.readJson("./tsconfig.dist.json"),
    Effect.orElse(() =>
      fsUtils.readJson("./tsconfig.base.json").pipe(
        Effect.orElse(() => fsUtils.readJson("./tsconfig.json")),
        Effect.map((config) => {
          delete config.extends
          delete config.exclude
          delete config.compilerOptions.outDir
          delete config.compilerOptions.baseUrl
          delete config.compilerOptions.rootDir
          delete config.compilerOptions.paths
          delete config.compilerOptions.tsBuildInfoFile
          delete config.compilerOptions.composite
          delete config.compilerOptions.declaration
          delete config.compilerOptions.declarationMap
          delete config.compilerOptions.plugins
          delete config.compilerOptions.types
          delete config.compilerOptions.noErrorTruncation
          config.compilerOptions.skipLibCheck = true
          config.include = ["**/*"]
          return config
        })
      )
    )
  )

  const gitIgnoreTemplate = yield* _(
    fs.readFileString("./.gitignore.template"),
    Effect.orElseSucceed(() => defaultGitignoreTemplate)
  )

  const packages = yield* _(topPackageJson.packages)

  const processPackage = (dir: string) =>
    Effect.gen(function*(_) {
      const pkgRaw = dir === "."
        ? topPackageJsonRaw
        : yield* _(fsUtils.readJson(path_.join(dir, "package.json")))
      const pkg = dir === "."
        ? topPackageJson
        : yield* _(PackageJson.decode(pkgRaw))
      const config = pkg.effect
      const exportPrefix = slugify(pkg.name)
      const entrypoints = yield* _(fsUtils.glob(pkg.preconstruct.entrypoints, {
        nodir: true,
        cwd: path_.join(dir, "src")
      }))
      const modules = entrypoints.filter((_) => _ !== "index.ts").map((_) =>
        _.replace(/\.tsx?$/, "")
      ).sort()
      const files = [
        "dist",
        ...(config.includeInternal ? ["internal"] : []),
        ...modules
          .reduce((acc: Array<string>, file) => {
            const topLevel = file.split("/")[0]
            if (!acc.includes(topLevel)) {
              acc.push(topLevel)
            }
            return acc
          }, [])
          .sort()
      ]
      const exports: Record<string, any> = {
        ".": {
          types: "./dist/declarations/src/index.d.ts",
          module: `./dist/${exportPrefix}.esm.js`,
          import: `./dist/${exportPrefix}.cjs.mjs`,
          default: `./dist/${exportPrefix}.cjs.js`
        },
        "./package.json": "./package.json"
      }
      modules.forEach((module) => {
        const moduleSafe = slugify(module)
        exports[`./${module}`] = {
          types: `./dist/declarations/src/${module}.d.ts`,
          module: `./${module}/dist/${exportPrefix}-${moduleSafe}.esm.js`,
          import: `./${module}/dist/${exportPrefix}-${moduleSafe}.cjs.mjs`,
          default: `./${module}/dist/${exportPrefix}-${moduleSafe}.cjs.js`
        }
      })
      const gitignore = `${gitIgnoreTemplate}

# files
/src/tsconfig.json
${files.map((_) => `/${_}`).join("\n")}
`
      const vscodeIgnore = Object.fromEntries(
        files.map((_) => [path_.join(dir, _), true])
      )

      return {
        pkg: {
          ...pkgRaw,
          files: ["src", ...files],
          exports
        },
        config: pkg.effect,
        modules,
        gitignore,
        vscodeIgnore
      } as const
    })

  interface PkgInfo
    extends Effect.Effect.Success<ReturnType<typeof processPackage>>
  {}

  const genIndex = (
    dir: string,
    pkgName: string,
    modules: ReadonlyArray<string>
  ) =>
    Effect.gen(function*(_) {
      const template = yield* _(
        fs.readFileString(path_.join(dir, "src/.index.ts")),
        Effect.map((_) => _.trim() + "\n\n"),
        Effect.orElseSucceed(() => "")
      )
      const content = yield* _(
        Effect.forEach(
          modules.filter((_) => !_.includes("/")),
          (module) =>
            Effect.map(
              fs.readFileString(path_.join(dir, "src", `${module}.ts`)),
              (content) => {
                const topComment = content.match(/\/\*\*\n.+?\*\//s)?.[0] ?? ""
                return `${topComment}
export * as ${module} from "${pkgName}/${module}"`
              }
            ),
          { concurrency: "inherit" }
        )
      )
      return `${template}${content.join("\n\n")}\n`
    })

  const handlePkgInfo = (
    dir: string,
    { config, gitignore, modules, pkg }: PkgInfo
  ) =>
    Effect.all([
      fsUtils.writeJson(path_.join(dir, "package.json"), pkg).pipe(
        Effect.uninterruptible
      ),
      fs.writeFileString(path_.join(dir, ".gitignore"), gitignore).pipe(
        Effect.uninterruptible
      ),
      config.generateIndex
        ? Effect.flatMap(
          genIndex(dir, pkg.name, modules),
          (content) =>
            fs.writeFileString(path_.join(dir, "src/index.ts"), content)
        )
        : Effect.void,
      fsUtils.writeJson(path_.join(dir, "src/tsconfig.json"), {
        ...tsConfig,
        compilerOptions: {
          ...tsConfig.compilerOptions,
          paths: {
            [pkg.name]: ["./index.ts"],
            [`${pkg.name}/*`]: ["./*.ts"]
          }
        }
      }).pipe(
        Effect.uninterruptible
      )
    ], { concurrency: "inherit", discard: true })

  const updateVscodeSettings = (ignore: Record<string, boolean>) =>
    fsUtils.readJson("./.vscode/settings.json").pipe(
      Effect.flatMap((settings) =>
        fsUtils.writeJson("./.vscode/settings.json", {
          ...settings,
          ["files.exclude"]: ignore
        })
      )
    )

  yield* _(
    Effect.forEach(packages, (dir) =>
      Effect.tap(
        processPackage(dir),
        (info) => handlePkgInfo(dir, info)
      ), { concurrency: "inherit" }),
    Effect.tap((infos) =>
      updateVscodeSettings(
        Array.reduce(
          infos,
          {},
          (a, b) => ({ ...a, ...b.vscodeIgnore })
        )
      ).pipe(
        Effect.ignore
      )
    ),
    Effect.withConcurrency(10),
    Effect.awaitAllChildren
  )
}).pipe(
  Effect.provide(
    Layer.mergeAll(FsUtilsLive, NodeFileSystem.layer, NodePath.layerPosix)
  )
)

class EffectConfig extends Schema.Class<EffectConfig>("EffectConfig")({
  generateIndex: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  includeInternal: Schema.optionalWith(Schema.Boolean, {
    default: () => false
  })
}) {
  static readonly default = new EffectConfig({
    generateIndex: false,
    includeInternal: false
  })
}

class PackageJson extends Schema.Class<PackageJson>("PackageJson")({
  name: Schema.String,
  preconstruct: Schema.Struct({
    entrypoints: Schema.optionalWith(Schema.Array(Schema.String), {
      default: () => []
    }),
    packages: Schema.optionalWith(Schema.NonEmptyArray(Schema.String), {
      as: "Option"
    })
  }),
  effect: Schema.optionalWith(EffectConfig, {
    default: () => EffectConfig.default
  })
}) {
  static readonly decode = Schema.decodeUnknown(this)

  get packages(): Effect.Effect<Array<string>, Error, FsUtils> {
    return Option.match(this.preconstruct.packages, {
      onNone: () => Effect.succeed(["."]),
      onSome: (globs) => Effect.flatMap(FsUtils, (fs) => fs.glob(globs))
    })
  }
}

// helpers

function slugify(str: string) {
  return str.replace(/^@/g, "").replace(/\//g, "-")
}
