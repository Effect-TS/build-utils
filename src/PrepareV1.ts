import { FileSystem, Path } from "@effect/platform-node"
import { Schema } from "@effect/schema"
import { Effect, Layer, Option, ReadonlyArray } from "effect"
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
  const fs = yield* _(FileSystem.FileSystem)
  const path_ = yield* _(Path.Path)
  const fsUtils = yield* _(FsUtils)

  const topPackageJsonRaw = yield* _(fsUtils.readJson("./package.json"))
  const topPackageJson = yield* _(PackageJson.parse(topPackageJsonRaw))

  const gitIgnoreTemplate = yield* _(
    fs.readFileString("./.gitignore.template"),
    Effect.orElseSucceed(() => defaultGitignoreTemplate),
  )

  const packages = yield* _(topPackageJson.packages)

  const processPackage = (dir: string) =>
    Effect.gen(function*(_) {
      const pkgRaw = dir === "."
        ? topPackageJsonRaw
        : yield* _(fsUtils.readJson(path_.join(dir, "package.json")))
      const pkg = dir === "."
        ? topPackageJson
        : yield* _(PackageJson.parse(pkgRaw))
      const config = pkg.effect
      const exportPrefix = slugify(pkg.name)
      const entrypoints = yield* _(fsUtils.glob(pkg.preconstruct.entrypoints, {
        nodir: true,
        cwd: path_.join(dir, "src"),
      }))
      const modules = entrypoints.filter(_ => _ !== "index.ts").map(_ =>
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
          .sort(),
      ]
      const exports: Record<string, any> = {
        ".": {
          types: "./dist/declarations/src/index.d.ts",
          module: `./dist/${exportPrefix}.esm.js`,
          import: `./dist/${exportPrefix}.cjs.mjs`,
          default: `./dist/${exportPrefix}.cjs.js`,
        },
        "./package.json": "./package.json",
      }
      modules.forEach(module => {
        const moduleSafe = slugify(module)
        exports[`./${module}`] = {
          types: `./dist/declarations/src/${module}.d.ts`,
          module: `./${module}/dist/${exportPrefix}-${moduleSafe}.esm.js`,
          import: `./${module}/dist/${exportPrefix}-${moduleSafe}.cjs.mjs`,
          default: `./${module}/dist/${exportPrefix}-${moduleSafe}.cjs.js`,
        }
      })
      const gitignore = `${gitIgnoreTemplate}

# files
${files.map(_ => `/${_}`).join("\n")}
`
      const vscodeIgnore = Object.fromEntries(
        files.map(_ => [path_.join(dir, _), true]),
      )

      return {
        pkg: {
          ...pkgRaw,
          files: ["src", ...files],
          exports,
        },
        config: pkg.effect,
        modules,
        gitignore,
        vscodeIgnore,
      } as const
    })

  interface PkgInfo
    extends Effect.Effect.Success<ReturnType<typeof processPackage>>
  {}

  const genIndex = (
    dir: string,
    pkgName: string,
    modules: ReadonlyArray<string>,
  ) =>
    Effect.gen(function*(_) {
      const template = yield* _(
        fs.readFileString(path_.join(dir, "src/.index.ts")),
        Effect.map(_ => _.trim() + "\n\n"),
        Effect.orElseSucceed(() => ""),
      )
      const content = yield* _(
        Effect.forEach(
          modules.filter(_ => !_.includes("/")),
          module =>
            Effect.map(
              fs.readFileString(path_.join(dir, "src", `${module}.ts`)),
              content => {
                const topComment = content.match(/\/\*\*\n.+?\*\//s)?.[0] ?? ""
                return `${topComment}
export * as ${module} from "${pkgName}/${module}"`
              },
            ),
          { concurrency: "inherit" },
        ),
      )
      return `${template}${content.join("\n\n")}\n`
    })

  const handlePkgInfo = (
    dir: string,
    { config, gitignore, modules, pkg }: PkgInfo,
  ) =>
    Effect.all([
      fsUtils.writeJson(path_.join(dir, "package.json"), pkg).pipe(
        Effect.uninterruptible,
      ),
      fs.writeFileString(path_.join(dir, ".gitignore"), gitignore).pipe(
        Effect.uninterruptible,
      ),
      config.generateIndex
        ? Effect.flatMap(
          genIndex(dir, pkg.name, modules),
          content =>
            fs.writeFileString(path_.join(dir, "src/index.ts"), content),
        )
        : Effect.unit,
    ], { concurrency: "inherit", discard: true })

  const updateVscodeSettings = (ignore: Record<string, boolean>) =>
    fsUtils.readJson("./.vscode/settings.json").pipe(
      Effect.flatMap(settings =>
        fsUtils.writeJson("./.vscode/settings.json", {
          ...settings,
          ["files.exclude"]: ignore,
        })
      ),
    )

  yield* _(
    Effect.forEach(packages, dir =>
      Effect.tap(
        processPackage(dir),
        info => handlePkgInfo(dir, info),
      ), { concurrency: "inherit" }),
    Effect.tap(infos =>
      updateVscodeSettings(
        ReadonlyArray.reduce(
          infos,
          {},
          (a, b) => ({ ...a, ...b.vscodeIgnore }),
        ),
      ).pipe(
        Effect.ignore,
      )
    ),
    Effect.withConcurrency(10),
    Effect.awaitAllChildren,
  )
}).pipe(
  Effect.provide(
    Layer.mergeAll(FsUtilsLive, FileSystem.layer, Path.layerPosix),
  ),
)

class EffectConfig extends Schema.Class<EffectConfig>()({
  generateIndex: Schema.optional(Schema.boolean).withDefault(() => false),
  includeInternal: Schema.optional(Schema.boolean).withDefault(() => false),
}) {
  static readonly default = new EffectConfig({
    generateIndex: false,
    includeInternal: false,
  })
}

class PackageJson extends Schema.Class<PackageJson>()({
  name: Schema.string,
  preconstruct: Schema.struct({
    entrypoints: Schema.optional(Schema.array(Schema.string)).withDefault(
      () => [],
    ),
    packages: Schema.optional(Schema.nonEmptyArray(Schema.string)).toOption(),
  }),
  effect: Schema.optional(EffectConfig).withDefault(() => EffectConfig.default),
}) {
  static readonly parse = Schema.parse(this)

  get packages(): Effect.Effect<FsUtils, Error, Array<string>> {
    return Option.match(this.preconstruct.packages, {
      onNone: () => Effect.succeed(["."]),
      onSome: globs => Effect.flatMap(FsUtils, fs => fs.glob(globs)),
    })
  }
}

// helpers

function slugify(str: string) {
  return str.replace(/^@/g, "").replace(/\//g, "-")
}
