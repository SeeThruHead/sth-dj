import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import { pickZone } from "../src/cli/Cli.ts"
import { Paths } from "../src/core/Paths.ts"
import { TestPlatformLayer } from "./helpers.ts"
import type { RoonZone } from "../src/core/RoonClient.ts"

const zone = (name: string, state: RoonZone["state"]): RoonZone => ({
  zone_id: `id-${name}`,
  display_name: name,
  state
})

const zones = [zone("Kitchen", "stopped"), zone("Living Room", "playing"), zone("Office", "paused")]

describe("pickZone", () => {
  it.effect("with no query prefers the playing zone", () =>
    Effect.gen(function* () {
      const picked = yield* pickZone(zones, Option.none())
      expect(picked.display_name).toBe("Living Room")
    })
  )

  it.effect("with no query and nothing playing falls back to the first zone", () =>
    Effect.gen(function* () {
      const picked = yield* pickZone(
        [zone("Kitchen", "stopped"), zone("Office", "paused")],
        Option.none()
      )
      expect(picked.display_name).toBe("Kitchen")
    })
  )

  it.effect("matches on a case-insensitive substring", () =>
    Effect.gen(function* () {
      const picked = yield* pickZone(zones, Option.some("kitch"))
      expect(picked.display_name).toBe("Kitchen")
    })
  )

  it.effect("matches an exact zone_id", () =>
    Effect.gen(function* () {
      const picked = yield* pickZone(zones, Option.some("id-Office"))
      expect(picked.display_name).toBe("Office")
    })
  )

  it.effect("fails with ZoneNotFound for an unknown name", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(pickZone(zones, Option.some("Basement")))
      expect(result._tag).toBe("Left")
      if (result._tag !== "Left") return
      expect(result.left._tag).toBe("ZoneNotFound")
      expect(result.left.query).toBe("Basement")
    })
  )

  it.effect("fails when there are no zones at all", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(pickZone([], Option.none()))
      expect(result._tag).toBe("Left")
    })
  )
})

const resolvePaths = (env: Record<string, string | undefined>) =>
  Effect.gen(function* () {
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    const paths = yield* Effect.provide(Paths, Layer.provide(Paths.Default, TestPlatformLayer)).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
          }
        })
      )
    )
    return paths
  })

describe("Paths", () => {
  it.effect("defaults to ~/.config/sth-dj", () =>
    Effect.gen(function* () {
      const home = path.join(os.tmpdir(), "sth-dj-home")
      const paths = yield* resolvePaths({ HOME: home, XDG_CONFIG_HOME: undefined })
      expect(paths.configDir).toBe(path.join(home, ".config", "sth-dj"))
      expect(paths.configFile).toBe(path.join(home, ".config", "sth-dj", "config.json"))
    })
  )

  it.effect("honours an absolute XDG_CONFIG_HOME", () =>
    Effect.gen(function* () {
      const xdg = path.join(os.tmpdir(), "xdg-root")
      const paths = yield* resolvePaths({ HOME: path.join(os.tmpdir(), "h"), XDG_CONFIG_HOME: xdg })
      expect(paths.configDir).toBe(path.join(xdg, "sth-dj"))
    })
  )

  it.effect("ignores a relative XDG_CONFIG_HOME", () =>
    Effect.gen(function* () {
      const home = path.join(os.tmpdir(), "sth-dj-home")
      const paths = yield* resolvePaths({ HOME: home, XDG_CONFIG_HOME: "relative/path" })
      expect(paths.configDir).toBe(path.join(home, ".config", "sth-dj"))
    })
  )
})
