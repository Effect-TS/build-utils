import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { FileSystem } from "@effect/platform/FileSystem"
import * as Schema from "@effect/schema/Schema"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const effectConfigDefaults = {
  generateExports: {
    include: ["*.ts", "impl/*.ts"],
    exclude: [],
  },
  generateIndex: {
    include: ["*.ts"],
    exclude: [],
  },
}
export class EffectConfig extends Schema.Class<EffectConfig>()({
  generateExports: Schema.optional(
    Schema.struct({
      include: Schema.optional(Schema.array(Schema.string), {
        default: () => effectConfigDefaults.generateExports.include,
      }),
      exclude: Schema.optional(Schema.array(Schema.string), {
        default: () => effectConfigDefaults.generateExports.exclude,
      }),
    }),
    { default: () => effectConfigDefaults.generateExports },
  ),
  generateIndex: Schema.optional(
    Schema.struct({
      include: Schema.optional(Schema.array(Schema.string), {
        default: () => effectConfigDefaults.generateIndex.include,
      }),
      exclude: Schema.optional(Schema.array(Schema.string), {
        default: () => effectConfigDefaults.generateIndex.exclude,
      }),
    }),
    { default: () => effectConfigDefaults.generateIndex },
  ),
}) {
  static readonly default = new EffectConfig(effectConfigDefaults)
}

export class PackageJson extends Schema.Class<PackageJson>()({
  name: Schema.string,
  version: Schema.string,
  description: Schema.string,
  private: Schema.optional(Schema.boolean, { default: () => false }),
  publishConfig: Schema.optional(Schema.struct({
    provenance: Schema.optional(Schema.boolean, { default: () => false }),
    executableFiles: Schema.optional(Schema.array(Schema.string)),
  })),
  license: Schema.string,
  author: Schema.optional(Schema.string),
  repository: Schema.union(
    Schema.string,
    Schema.struct({
      type: Schema.string,
      url: Schema.string,
      directory: Schema.optional(Schema.string),
    }),
  ),
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
  effect: Schema.optional(EffectConfig, {
    default: () => EffectConfig.default,
  }),
}) {
  static readonly decode = Schema.decodeUnknown(this)
}

const make = Effect.gen(function*(_) {
  const fs = yield* _(FileSystem)

  const packageJson = fs.readFileString("./package.json").pipe(
    Effect.map(_ => JSON.parse(_)),
    Effect.flatMap(PackageJson.decode),
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
export const PackageContext = Context.GenericTag<PackageContext>(
  "@effect/build-tools/PackageContext",
)
export const PackageContextLive = Layer.effect(PackageContext, make).pipe(
  Layer.provide(NodeFileSystem.layer),
)
