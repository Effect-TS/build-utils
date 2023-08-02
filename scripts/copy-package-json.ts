import * as FileSystem from "@effect/platform-node/FileSystem"
import { Effect, pipe, ReadonlyRecord } from "effect"
import * as path from "node:path"

const excludeEffectPackages = (
  deps: Record<string, string>,
): Record<string, string> => {
  return ReadonlyRecord.filter(deps, (_, k) => !k.startsWith("@effect"))
}

const read = pipe(
  FileSystem.FileSystem,
  Effect.flatMap(fileSystem => fileSystem.readFileString("package.json")),
  Effect.map(JSON.parse),
  Effect.map(json => ({
    name: json.name,
    version: json.version,
    description: json.description,
    main: "bin.js",
    bin: "bin.js",
    engines: json.engines,
    dependencies: excludeEffectPackages(json.dependencies),
    peerDependencies: excludeEffectPackages(json.peerDependencies),
    repository: json.repository,
    author: json.author,
    license: json.license,
    bugs: json.bugs,
    homepage: json.homepage,
    tags: json.tags,
    keywords: json.keywords,
  })),
)

const pathTo = path.join("dist", "package.json")

const write = (pkg: object) =>
  pipe(
    FileSystem.FileSystem,
    Effect.flatMap(fileSystem =>
      fileSystem.writeFile(
        pathTo,
        new TextEncoder().encode(JSON.stringify(pkg, null, 2)),
      )
    ),
  )

const program = pipe(
  Effect.sync(() => console.log(`copying package.json to ${pathTo}...`)),
  Effect.flatMap(() => read),
  Effect.flatMap(write),
  Effect.provideLayer(FileSystem.layer),
)

Effect.runPromise(program)
