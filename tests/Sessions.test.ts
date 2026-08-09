import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { Sessions, SessionNotFound } from "../src/core/Sessions.ts"
import { cleanupDir, makeTempDir, TestPathsLayer, TestPlatformLayer } from "./helpers.ts"

const withSandbox = <A, E>(
  body: (root: string) => Effect.Effect<A, E, Sessions>
) =>
  Effect.acquireUseRelease(
    makeTempDir,
    (root) =>
      body(root).pipe(
        Effect.provide(Sessions.Default),
        Effect.provide(TestPathsLayer(root)),
        Effect.provide(TestPlatformLayer)
      ),
    (root) => Effect.orDie(cleanupDir(root))
  )

describe("Sessions", () => {
  it.effect("starts empty", () =>
    withSandbox(() =>
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const all = yield* sessions.list
        expect(all).toEqual([])
        const cur = yield* sessions.current
        expect(Option.isNone(cur)).toBe(true)
      })
    )
  )

  it.effect("start → append → current → end roundtrip", () =>
    withSandbox(() =>
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const started = yield* sessions.start("late-night drive")
        expect(started.name).toBe("late-night drive")
        expect(started.entries).toEqual([])

        yield* sessions.append({
          action: "play",
          zone: "Living Room",
          query: "Aurora Runaway",
          resolved: "Runaway"
        })

        const cur = yield* sessions.current
        expect(Option.isSome(cur)).toBe(true)
        if (Option.isSome(cur)) {
          expect(cur.value.entries).toHaveLength(1)
          expect(cur.value.entries[0]?.resolved).toBe("Runaway")
        }

        const ended = yield* sessions.end
        expect(Option.isSome(ended)).toBe(true)
        if (Option.isSome(ended)) {
          expect(ended.value.endedAt).toBeDefined()
        }

        const after = yield* sessions.current
        expect(Option.isNone(after)).toBe(true)
      })
    )
  )

  it.effect("end with no active session is None", () =>
    withSandbox(() =>
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const ended = yield* sessions.end
        expect(Option.isNone(ended)).toBe(true)
      })
    )
  )

  it.effect("get unknown id fails with SessionNotFound", () =>
    withSandbox(() =>
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const result = yield* Effect.flip(sessions.get("does-not-exist"))
        expect(result).toBeInstanceOf(SessionNotFound)
        if (result instanceof SessionNotFound) {
          expect(result.id).toBe("does-not-exist")
        }
      })
    )
  )

  it.live(
    "list returns sessions newest-first",
    () =>
      withSandbox(() =>
        Effect.gen(function* () {
          const sessions = yield* Sessions
          const a = yield* sessions.start("first")
          yield* sessions.end
          yield* Effect.sleep("1100 millis")
          const b = yield* sessions.start("second")
          yield* sessions.end

          const all = yield* sessions.list
          expect(all).toHaveLength(2)
          expect(all[0]?.id).toBe(b.id)
          expect(all[1]?.id).toBe(a.id)
        })
      ),
    { timeout: 10_000 }
  )

  it.effect("append with no active session is a no-op", () =>
    withSandbox(() =>
      Effect.gen(function* () {
        const sessions = yield* Sessions
        yield* sessions.append({
          action: "play",
          zone: "Living Room",
          query: "anything"
        })
        const all = yield* sessions.list
        expect(all).toEqual([])
      })
    )
  )
})
