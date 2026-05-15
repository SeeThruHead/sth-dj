import { Effect } from "effect"
import { Path } from "@effect/platform"

const homeDir = Effect.sync(() => process.env.HOME ?? process.env.USERPROFILE ?? null).pipe(
  Effect.flatMap((home) =>
    home === null ? Effect.die(new Error("HOME / USERPROFILE not set")) : Effect.succeed(home)
  )
)

/**
 * Resolved filesystem locations used by the app.
 * Pure derivation — no I/O, no service registration.
 */
export class Paths extends Effect.Service<Paths>()("sth-dj/Paths", {
  effect: Effect.gen(function* () {
    const path = yield* Path.Path
    const home = yield* homeDir
    const configDir = path.join(home, ".config", "sth-dj")
    return {
      configDir,
      roonStateFile: path.join(configDir, "roon-state.json"),
      envFile: path.join(configDir, ".env"),
      sessionsDir: path.join(configDir, "sessions"),
      pointerFile: path.join(configDir, "current-session.json")
    } as const
  })
}) {}
