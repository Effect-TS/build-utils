#!/usr/bin/env node

import * as CliApp from "@effect/cli/CliApp"
import * as Command from "@effect/cli/Command"
import * as Console from "@effect/cli/Console"
import { runMain } from "@effect/platform-node/Runtime"
import { Effect, Match, pipe } from "effect"
import * as PackV1 from "./PackV1"

const packV1 = Command.make("pack-v1")

const buildUtils = pipe(
  Command.make("build-utils"),
  Command.subcommands([packV1]),
)

const cli = CliApp.make({
  name: "Effect Build Utils",
  version: "0.0.0",
  command: buildUtils,
})

const handleCommand = Match.type<
  Command.Command.GetParsedType<typeof buildUtils>
>().pipe(
  Match.when(
    { subcommand: { _tag: "Some", value: { name: "pack-v1" } } },
    () => PackV1.run,
  ),
  Match.orElse(() => Effect.dieMessage("unknown command")),
)

Effect.sync(() => process.argv.slice(2)).pipe(
  Effect.flatMap(args => CliApp.run(cli, args, handleCommand)),
  Effect.provideLayer(Console.layer),
  Effect.tapErrorCause(Effect.logError),
  runMain,
)
