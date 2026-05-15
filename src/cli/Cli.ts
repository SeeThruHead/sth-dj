import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { RoonClient, type RoonZone } from "../core/RoonClient.ts"
import { Sessions } from "../core/Sessions.ts"

const zoneOpt = Options.text("zone").pipe(
  Options.withAlias("z"),
  Options.withDescription("Zone name or zone_id (substring match)"),
  Options.optional
)

const jsonOpt = Options.boolean("json").pipe(
  Options.withDescription("Emit machine-readable JSON"),
  Options.withDefault(false)
)

const resolveZone = (zoneOpt: { _tag: "None" } | { _tag: "Some"; value: string }, zs: RoonZone[]) => {
  if (zoneOpt._tag === "Some") {
    const lower = zoneOpt.value.toLowerCase()
    return zs.find(
      (z) => z.zone_id === zoneOpt.value || z.display_name.toLowerCase().includes(lower)
    )
  }
  return zs.find((z) => z.state === "playing") ?? zs[0]
}

// ---- zones ----
const zones = Command.make("zones", { json: jsonOpt }, ({ json }) =>
  Effect.gen(function* () {
    const roon = yield* RoonClient
    if (!json) yield* Console.log("Pairing with Roon (open Roon → Settings → Extensions → Enable 'STH DJ' if first run)…")
    yield* roon.waitForCore
    const zs = yield* roon.getZones
    if (json) {
      yield* Console.log(JSON.stringify(zs, null, 2))
      return
    }
    if (zs.length === 0) {
      yield* Console.log("No zones found.")
      return
    }
    for (const z of zs) {
      yield* Console.log(`${z.display_name} [${z.state}]`)
      yield* Console.log(`  zone_id: ${z.zone_id}`)
    }
  })
)

// ---- now ----
const now = Command.make("now", { zone: zoneOpt, json: jsonOpt }, ({ zone, json }) =>
  Effect.gen(function* () {
    const roon = yield* RoonClient
    yield* roon.waitForCore
    const zs = yield* roon.getZones
    const target = resolveZone(zone, zs)
    if (!target) {
      if (json) yield* Console.log("null")
      else yield* Console.log("No matching zone.")
      return
    }
    if (json) {
      yield* Console.log(JSON.stringify(target, null, 2))
      return
    }
    yield* Console.log(`Zone: ${target.display_name} [${target.state}]`)
    const np = target.now_playing
    if (np?.three_line) {
      yield* Console.log(`  ${np.three_line.line1}`)
      yield* Console.log(`  ${np.three_line.line2}`)
      yield* Console.log(`  ${np.three_line.line3}`)
    } else if (np?.two_line) {
      yield* Console.log(`  ${np.two_line.line1} — ${np.two_line.line2}`)
    } else {
      yield* Console.log("  (nothing playing)")
    }
  })
)

// ---- play / queue ----
const queryArg = Args.text({ name: "query" })

const play = Command.make("play", { query: queryArg, zone: zoneOpt }, ({ query, zone }) =>
  Effect.gen(function* () {
    const roon = yield* RoonClient
    const sessions = yield* Sessions
    yield* roon.waitForCore
    const zs = yield* roon.getZones
    const target = resolveZone(zone, zs)
    if (!target) return yield* Effect.fail(new Error("no zone available"))
    const resolved = yield* roon.searchAndPlay(target.zone_id, query)
    yield* sessions.append({ action: "play", zone: target.display_name, query, resolved })
    yield* Console.log(`▶ ${resolved}  →  ${target.display_name}`)
  })
)

// ---- transport controls ----
const transport = (action: "play" | "pause" | "playpause" | "stop" | "previous" | "next") =>
  Command.make(action, { zone: zoneOpt }, ({ zone }) =>
    Effect.gen(function* () {
      const roon = yield* RoonClient
      yield* roon.waitForCore
      const zs = yield* roon.getZones
      const target = resolveZone(zone, zs)
      if (!target) return yield* Effect.fail(new Error("no zone available"))
      yield* roon.control(target.zone_id, action)
      yield* Console.log(`${action} → ${target.display_name}`)
    })
  )

// ---- session ----
const sessionStart = Command.make(
  "start",
  { name: Args.text({ name: "name" }) },
  ({ name }) =>
    Sessions.pipe(
      Effect.flatMap((s) => s.start(name)),
      Effect.flatMap((s) => Console.log(`session started: ${s.id}  (${s.name})`))
    )
)

const sessionEnd = Command.make("end", {}, () =>
  Sessions.pipe(
    Effect.flatMap((s) => s.end),
    Effect.flatMap((s) =>
      Console.log(s ? `session ended: ${s.id}  (${s.entries.length} entries)` : "no active session")
    )
  )
)

const sessionList = Command.make("list", { json: jsonOpt }, ({ json }) =>
  Sessions.pipe(
    Effect.flatMap((s) => s.list),
    Effect.flatMap((all) =>
      json
        ? Console.log(JSON.stringify(all, null, 2))
        : Effect.forEach(all, (s) =>
            Console.log(
              `${s.id}  ${s.name}  [${s.endedAt ? "ended" : "active"}]  (${s.entries.length} entries)`
            )
          )
    )
  )
)

const sessionShow = Command.make(
  "show",
  { id: Args.text({ name: "id" }).pipe(Args.optional), json: jsonOpt },
  ({ id, json }) =>
    Effect.gen(function* () {
      const sessions = yield* Sessions
      const s =
        id._tag === "Some"
          ? yield* sessions.get(id.value)
          : yield* sessions.current
      if (!s) {
        if (json) yield* Console.log("null")
        else yield* Console.log("no session")
        return
      }
      if (json) {
        yield* Console.log(JSON.stringify(s, null, 2))
        return
      }
      yield* Console.log(`${s.id}  ${s.name}`)
      for (const e of s.entries) {
        yield* Console.log(`  [${e.ts}] ${e.action} ${e.zone}: ${e.resolved ?? e.query}`)
      }
    })
)

const session = Command.make("session").pipe(
  Command.withSubcommands([sessionStart, sessionEnd, sessionList, sessionShow])
)

const root = Command.make("sth-dj").pipe(
  Command.withSubcommands([
    zones,
    now,
    play,
    transport("pause"),
    transport("playpause"),
    transport("next"),
    transport("previous"),
    transport("stop"),
    session
  ])
)

export const cli = Command.run(root, {
  name: "sth-dj",
  version: "0.0.1"
})
