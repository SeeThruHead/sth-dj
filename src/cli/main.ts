import { NodeContext } from "@effect/platform-node"
import { Cause, Console, Effect, Exit, Layer } from "effect"
import { cli } from "./Cli.ts"
import { RoonClient } from "../core/RoonClient.ts"
import { Sessions } from "../core/Sessions.ts"
import { Paths } from "../core/Paths.ts"
import { AppConfig } from "../core/AppConfig.ts"
import { loadEnvFile } from "../core/Config.ts"

const MainLayer = Layer.mergeAll(RoonClient.Default, Sessions.Default).pipe(
  Layer.provideMerge(AppConfig.Default),
  Layer.provideMerge(Paths.Default),
  Layer.provideMerge(NodeContext.layer)
)

const checkConfig = AppConfig.pipe(
  Effect.flatMap((c) => c.load),
  Effect.asVoid,
  Effect.catchTag("AppConfigError", (err) =>
    Console.error(`sth-dj: ${err.reason}`).pipe(
      Effect.flatMap(() => Effect.sync(() => process.exit(1)))
    )
  )
)

const program = loadEnvFile.pipe(
  Effect.flatMap(() => checkConfig),
  Effect.flatMap(() => Effect.suspend(() => cli(process.argv))),
  Effect.provide(MainLayer)
)

const flushStdout = () =>
  new Promise<void>((resolve) => {
    if (process.stdout.writableLength === 0) return resolve()
    process.stdout.write("", () => resolve())
  })

const exit = await Effect.runPromiseExit(program)

if (Exit.isFailure(exit) && !Cause.isInterruptedOnly(exit.cause)) {
  console.error(Cause.pretty(exit.cause))
  process.exitCode = 1
}

await flushStdout()
process.exit(process.exitCode ?? 0)
