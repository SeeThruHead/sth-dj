import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { cli } from "./Cli.ts"
import { RoonClientLive } from "../core/RoonClient.ts"
import { SessionsLive } from "../core/Sessions.ts"
import { readEnvFileInto } from "../core/Config.ts"

const MainLayer = Layer.mergeAll(RoonClientLive, SessionsLive, NodeContext.layer)

readEnvFileInto.pipe(
  Effect.flatMap(() => Effect.suspend(() => cli(process.argv))),
  Effect.provide(MainLayer),
  NodeRuntime.runMain
)
