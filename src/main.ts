#!/usr/bin/env node

import * as CliApp from "@effect/cli/CliApp"
import * as Command from "@effect/cli/Command"
import { runMain } from "@effect/platform-node/Runtime"
import { Effect, Match, pipe } from "effect"
import * as PackV1 from "./PackV1"
import * as PrepareV1 from "./PrepareV1"
import * as PrepareV2 from "./PrepareV2"

const packV1 = Command.make("pack-v1")
const prepareV1 = Command.make("prepare-v1")
const prepareV2 = Command.make("prepare-v2")

const buildUtils = pipe(
  Command.make("build-utils"),
  Command.subcommands([packV1, prepareV1, prepareV2]),
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
  Match.when(
    { subcommand: { _tag: "Some", value: { name: "prepare-v1" } } },
    () => PrepareV1.run,
  ),
  Match.when(
    { subcommand: { _tag: "Some", value: { name: "prepare-v2" } } },
    () => PrepareV2.run,
  ),
  Match.orElse(() => Effect.dieMessage("unknown command")),
)

Effect.sync(() => process.argv.slice(2)).pipe(
  Effect.flatMap(args => CliApp.run(cli, args, handleCommand)),
  Effect.tapErrorCause(Effect.logError),
  runMain,
)
