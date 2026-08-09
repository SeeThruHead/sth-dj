#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
// @ts-expect-error
delete globalThis.WebSocket
const { NodeContext, NodeRuntime } = await import("@effect/platform-node")
const { Effect, Layer } = await import("effect")
const { RoonClient } = await import("../src/core/RoonClient.ts")
const { Paths } = await import("../src/core/Paths.ts")
const { AppConfig } = await import("../src/core/AppConfig.ts")
const { Option } = await import("effect")

const MainLayer = Layer.mergeAll(RoonClient.Default).pipe(
  Layer.provideMerge(AppConfig.Default),
  Layer.provideMerge(Paths.Default),
  Layer.provideMerge(NodeContext.layer)
)

const query = process.argv[2] ?? "AURORA Murder Song"

const program = Effect.gen(function* () {
  const roon = yield* RoonClient
  const configured = yield* AppConfig.pipe(Effect.flatMap((c) => c.defaultZone))
  const zones = yield* roon.getZones
  const zone = Option.match(configured, {
    onNone: () => zones[0],
    onSome: (name) => zones.find((z) => z.display_name === name) ?? zones[0]
  })
  if (!zone) return
  const core = yield* roon.waitForCore
  const browse = (opts: any) =>
    Effect.async<any, never>((resume) => {
      core.services.RoonApiBrowse.browse(opts, (msg, body) => resume(Effect.succeed({ msg, body })))
    })
  const load = (opts: any) =>
    Effect.async<any, never>((resume) => {
      core.services.RoonApiBrowse.load(opts, (msg, body) => resume(Effect.succeed({ msg, body })))
    })

  // Search
  yield* browse({ hierarchy: "search", pop_all: true, input: query, zone_or_output_id: zone.zone_id })
  const sections = yield* load({ hierarchy: "search" })
  const tracks = sections.body.items.find((i: any) => i.title === "Tracks")
  console.log("Tracks section:", tracks)
  yield* browse({ hierarchy: "search", item_key: tracks.item_key, zone_or_output_id: zone.zone_id })
  const trackList = yield* load({ hierarchy: "search" })
  console.log("Track list:", JSON.stringify(trackList.body.items.slice(0, 3), null, 2))

  // Activate first track
  const first = trackList.body.items[0]
  console.log("\nActivate:", first.title)
  const actBrowse = yield* browse({ hierarchy: "search", item_key: first.item_key, zone_or_output_id: zone.zone_id })
  console.log("activate browse response:", JSON.stringify(actBrowse, null, 2))
  const actions = yield* load({ hierarchy: "search" })
  console.log("actions:", JSON.stringify(actions.body, null, 2))

  // Drill one more level
  const inner = actions.body.items[0]
  console.log("\nDrill into:", inner.title, "hint:", inner.hint)
  yield* browse({ hierarchy: "search", item_key: inner.item_key, zone_or_output_id: zone.zone_id })
  const inner2 = yield* load({ hierarchy: "search" })
  console.log("inner items:", JSON.stringify(inner2.body, null, 2))
})

program.pipe(Effect.provide(MainLayer), NodeRuntime.runMain)
