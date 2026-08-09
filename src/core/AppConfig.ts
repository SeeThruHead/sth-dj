import { Config, ConfigProvider, Effect, Option, Schema } from "effect"
import { FileSystem } from "@effect/platform"
import { Paths } from "./Paths.ts"

export class AppConfigError extends Schema.TaggedError<AppConfigError>()(
  "AppConfigError",
  { reason: Schema.String }
) {}

export type AppConfigValues = {
  readonly publisher: string
  readonly email: string
  readonly defaultZone: Option.Option<string>
}

const values = Config.all({
  publisher: Config.nonEmptyString("publisher"),
  email: Config.nonEmptyString("email"),
  defaultZone: Config.option(Config.nonEmptyString("defaultZone"))
})

const missingConfig = (file: string) =>
  new AppConfigError({
    reason: [
      `no config found at ${file}`,
      "",
      "Create it with:",
      "",
      `  mkdir -p "$(dirname "${file}")"`,
      `  cat > "${file}" <<'JSON'`,
      "  {",
      '    "publisher": "Your Name",',
      '    "email": "you@example.com",',
      '    "defaultZone": "Living Room"',
      "  }",
      "  JSON",
      "",
      "publisher and email are shown in Roon under Settings -> Extensions.",
      "defaultZone is optional."
    ].join("\n")
  })

export class AppConfig extends Effect.Service<AppConfig>()("sth-dj/AppConfig", {
  effect: Effect.gen(function* () {
    const paths = yield* Paths
    const fs = yield* FileSystem.FileSystem

    const load: Effect.Effect<AppConfigValues, AppConfigError> = Effect.gen(function* () {
      const exists = yield* fs.exists(paths.configFile).pipe(Effect.orElseSucceed(() => false))
      if (!exists) return yield* Effect.fail(missingConfig(paths.configFile))

      const text = yield* fs.readFileString(paths.configFile).pipe(
        Effect.mapError(
          (cause) => new AppConfigError({ reason: `reading ${paths.configFile}: ${cause}` })
        )
      )
      const parsed = yield* Effect.try({
        try: () => JSON.parse(text) as Record<string, unknown>,
        catch: (cause) =>
          new AppConfigError({ reason: `invalid JSON in ${paths.configFile}: ${cause}` })
      })

      return yield* values.pipe(
        Effect.withConfigProvider(ConfigProvider.fromJson(parsed)),
        Effect.mapError(
          (cause) => new AppConfigError({ reason: `${paths.configFile}: ${cause}` })
        )
      )
    })

    const defaultZone = load.pipe(Effect.map((c) => c.defaultZone))

    return { path: paths.configFile, load, defaultZone } as const
  })
}) {}
