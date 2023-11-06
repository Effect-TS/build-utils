import * as FileSystem from "@effect/platform-node/FileSystem"
import * as Schema from "@effect/schema/Schema"
import { Context, Effect, Layer } from "effect"

export class EffectConfig extends Schema.Class<EffectConfig>()({
  publicModules: Schema.optional(Schema.array(Schema.string)).withDefault(
    () => ["*.ts"],
  ),
}) {
  static readonly default = new EffectConfig({
    publicModules: ["*.ts"],
  })
}

export class PackageJson extends Schema.Class<PackageJson>()({
  name: Schema.string,
  version: Schema.string,
  description: Schema.string,
  private: Schema.optional(Schema.boolean).withDefault(() => false),
  license: Schema.string,
  author: Schema.optional(Schema.string),
  repository: Schema.struct({
    type: Schema.string,
    url: Schema.string,
  }),
  dependencies: Schema.optional(Schema.record(Schema.string, Schema.string)),
  peerDependencies: Schema.optional(
    Schema.record(Schema.string, Schema.string),
  ),
  peerDependenciesMeta: Schema.optional(
    Schema.record(Schema.string, Schema.struct({ optional: Schema.boolean })),
  ),
  optionalDependencies: Schema.optional(
    Schema.record(Schema.string, Schema.string),
  ),
  gitHead: Schema.optional(Schema.string),
  bin: Schema.optional(Schema.unknown),
  effect: Schema.optional(EffectConfig).withDefault(() => EffectConfig.default),
}) {
  static readonly parse = Schema.parse(this)
}

const make = Effect.gen(function*(_) {
  const fs = yield* _(FileSystem.FileSystem)

  const packageJson = fs.readFileString("./package.json").pipe(
    Effect.map(_ => JSON.parse(_)),
    Effect.flatMap(PackageJson.parse),
    Effect.withSpan("PackageContext/packageJson"),
  )

  const hasMainCjs = fs.exists("./build/cjs/index.js")
  const hasMainMjs = fs.exists("./build/mjs/index.mjs")
  const hasMainEsm = fs.exists("./build/esm/index.js")
  const hasCjs = fs.exists("./build/cjs")
  const hasMjs = fs.exists("./build/mjs")
  const hasEsm = fs.exists("./build/esm")
  const hasDts = fs.exists("./build/dts")
  const hasSrc = fs.exists("./src")

  return yield* _(
    Effect.all({
      packageJson,
      hasMainCjs,
      hasMainMjs,
      hasMainEsm,
      hasCjs,
      hasMjs,
      hasEsm,
      hasDts,
      hasSrc,
    }, { concurrency: "inherit" }),
    Effect.let(
      "hasMain",
      ({ hasMainCjs, hasMainEsm, hasMainMjs }) =>
        hasMainCjs || hasMainMjs || hasMainEsm,
    ),
    Effect.withSpan("PackageContext/make"),
  )
})

export interface PackageContext extends Effect.Effect.Success<typeof make> {}
export const PackageContext = Context.Tag<PackageContext>(
  "@effect/build-tools/PackageContext",
)
export const PackageContextLive = Layer.effect(PackageContext, make).pipe(
  Layer.use(FileSystem.layer),
)
