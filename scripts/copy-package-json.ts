import * as FileSystem from "@effect/platform-node/FileSystem"
import { Effect, pipe, ReadonlyRecord } from "effect"
import * as path from "node:path"

const excludeEffectPackages = (
  deps: Record<string, string>,
): Record<string, string> => {
  return ReadonlyRecord.filter(deps, (_, k) => !k.includes("effect"))
}

const read = pipe(
  FileSystem.FileSystem,
  Effect.flatMap(fileSystem => fileSystem.readFileString("package.json")),
  Effect.map(_ => JSON.parse(_)),
  Effect.map(json => ({
    name: json.name,
    version: json.version,
    description: json.description,
    bin: {
      "pack-v1": "pack-v1.js",
    },
    engines: json.engines,
    dependencies: excludeEffectPackages(json.dependencies),
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
