import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { AppConfig } from "../src/core/AppConfig.ts"
import { cleanupDir, makeTempDir, TestPathsLayer, TestPlatformLayer } from "./helpers.ts"

const withSandbox = <A, E>(body: (root: string) => Effect.Effect<A, E, AppConfig>) =>
  Effect.acquireUseRelease(
    makeTempDir,
    (root) =>
      body(root).pipe(
        Effect.provide(AppConfig.Default),
        Effect.provide(TestPathsLayer(root)),
        Effect.provide(TestPlatformLayer)
      ),
    (root) => Effect.orDie(cleanupDir(root))
  )

const writeConfig = (root: string, contents: string) =>
  Effect.promise(() => fs.writeFile(path.join(root, "config.json"), contents))

describe("AppConfig", () => {
  it.effect("reports a missing config with instructions", () =>
    withSandbox(() =>
      Effect.gen(function* () {
        const cfg = yield* AppConfig
        const result = yield* Effect.either(cfg.load)
        expect(result._tag).toBe("Left")
        if (result._tag !== "Left") return
        expect(result.left._tag).toBe("AppConfigError")
        expect(result.left.reason).toContain("no config found")
        expect(result.left.reason).toContain("publisher")
        expect(result.left.reason).toContain("email")
      })
    )
  )

  it.effect("loads publisher, email and defaultZone", () =>
    withSandbox((root) =>
      Effect.gen(function* () {
        yield* writeConfig(
          root,
          JSON.stringify({ publisher: "Jane", email: "jane@example.com", defaultZone: "Kitchen" })
        )
        const cfg = yield* AppConfig
        const loaded = yield* cfg.load
        expect(loaded.publisher).toBe("Jane")
        expect(loaded.email).toBe("jane@example.com")
        expect(Option.getOrNull(loaded.defaultZone)).toBe("Kitchen")
      })
    )
  )

  it.effect("treats defaultZone as optional", () =>
    withSandbox((root) =>
      Effect.gen(function* () {
        yield* writeConfig(root, JSON.stringify({ publisher: "Jane", email: "jane@example.com" }))
        const cfg = yield* AppConfig
        const loaded = yield* cfg.load
        expect(Option.isNone(loaded.defaultZone)).toBe(true)
        const zone = yield* cfg.defaultZone
        expect(Option.isNone(zone)).toBe(true)
      })
    )
  )

  it.effect("names the missing key when a required field is absent", () =>
    withSandbox((root) =>
      Effect.gen(function* () {
        yield* writeConfig(root, JSON.stringify({ publisher: "Jane" }))
        const cfg = yield* AppConfig
        const result = yield* Effect.either(cfg.load)
        expect(result._tag).toBe("Left")
        if (result._tag !== "Left") return
        expect(result.left.reason).toContain("email")
      })
    )
  )

  it.effect("rejects an empty required field", () =>
    withSandbox((root) =>
      Effect.gen(function* () {
        yield* writeConfig(root, JSON.stringify({ publisher: "", email: "jane@example.com" }))
        const cfg = yield* AppConfig
        const result = yield* Effect.either(cfg.load)
        expect(result._tag).toBe("Left")
      })
    )
  )

  it.effect("reports malformed JSON distinctly from a missing file", () =>
    withSandbox((root) =>
      Effect.gen(function* () {
        yield* writeConfig(root, "{ not json")
        const cfg = yield* AppConfig
        const result = yield* Effect.either(cfg.load)
        expect(result._tag).toBe("Left")
        if (result._tag !== "Left") return
        expect(result.left.reason).toContain("invalid JSON")
      })
    )
  )
})
