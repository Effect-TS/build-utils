#!/usr/bin/env node

import * as Command from "@effect/cli/Command"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { runMain } from "@effect/platform-node/Runtime"
import * as Effect from "effect/Effect"
import * as PackV1 from "./PackV1"
import * as PackV2 from "./PackV2"
import * as PrepareV1 from "./PrepareV1"
import * as PrepareV2 from "./PrepareV2"

const run = Command.make("build-utils").pipe(
  Command.withSubcommands([
    Command.make("pack-v1", {}, () => PackV1.run),
    Command.make("pack-v2", {}, () => PackV2.run),
    Command.make("prepare-v1", {}, () => PrepareV1.run),
    Command.make("prepare-v2", {}, () => PrepareV2.run),
  ]),
  Command.run({
    name: "Effect Build Utils",
    version: "0.0.0",
  }),
)

run(process.argv.slice(2)).pipe(
  Effect.provide(NodeContext.layer),
  Effect.tapErrorCause(Effect.logError),
  runMain,
)
