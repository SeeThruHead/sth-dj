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
    const xdg = process.env.XDG_CONFIG_HOME
    const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config")
    const configDir = path.join(base, "sth-dj")
    return {
      configDir,
      configFile: path.join(configDir, "config.json"),
      roonStateFile: path.join(configDir, "roon-state.json"),
      envFile: path.join(configDir, ".env"),
      sessionsDir: path.join(configDir, "sessions"),
      pointerFile: path.join(configDir, "current-session.json")
    } as const
  })
}) {}
