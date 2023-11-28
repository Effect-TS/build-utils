#!/usr/bin/env node

import * as Command from "@effect/cli/Command"
import * as NodeContext from "@effect/platform-node/NodeContext"
import { runMain } from "@effect/platform-node/Runtime"
import { Effect, pipe } from "effect"
import * as PackV1 from "./PackV1"
import * as PackV2 from "./PackV2"
import * as PrepareV1 from "./PrepareV1"
import * as PrepareV2 from "./PrepareV2"

const packV1 = Command.make("pack-v1", {}, () => PackV1.run)
const packV2 = Command.make("pack-v2", {}, () => PackV2.run)
const prepareV1 = Command.make("prepare-v1", {}, () => PrepareV1.run)
const prepareV2 = Command.make("prepare-v2", {}, () => PrepareV2.run)

const cli = pipe(
  Command.makeHelp("build-utils"),
  Command.withSubcommands([packV1, packV2, prepareV1, prepareV2]),
  Command.run({
    name: "Effect Build Utils",
    version: "0.0.0",
  }),
)

Effect.suspend(() => cli(process.argv.slice(2))).pipe(
  Effect.provide(NodeContext.layer),
  Effect.tapErrorCause(Effect.logError),
  runMain,
)
