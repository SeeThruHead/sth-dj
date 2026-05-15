import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { cli } from "./Cli.ts"
import { RoonClient } from "../core/RoonClient.ts"
import { Sessions } from "../core/Sessions.ts"
import { Paths } from "../core/Paths.ts"
import { loadEnvFile } from "../core/Config.ts"

const MainLayer = Layer.mergeAll(RoonClient.Default, Sessions.Default).pipe(
  Layer.provideMerge(Paths.Default),
  Layer.provideMerge(NodeContext.layer)
)

loadEnvFile.pipe(
  Effect.flatMap(() => Effect.suspend(() => cli(process.argv))),
  Effect.provide(MainLayer),
  NodeRuntime.runMain
)
