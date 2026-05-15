import { Args, Command, Options } from "@effect/cli"
import { Console, Effect, Match, Option } from "effect"
import { RoonClient, type RoonZone, type TransportAction, ZoneNotFound } from "../core/RoonClient.ts"
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

const queryArg = Args.text({ name: "query" })

const pickZone = (zones: RoonZone[], query: Option.Option<string>): Effect.Effect<RoonZone, ZoneNotFound> =>
  Option.match(query, {
    onNone: () => {
      const playing = zones.find((z) => z.state === "playing") ?? zones[0]
      return playing
        ? Effect.succeed(playing)
        : Effect.fail(new ZoneNotFound({ query: "<default>" }))
    },
    onSome: (q) => {
      const lower = q.toLowerCase()
      const match = zones.find(
        (z) => z.zone_id === q || z.display_name.toLowerCase().includes(lower)
      )
      return match ? Effect.succeed(match) : Effect.fail(new ZoneNotFound({ query: q }))
    }
  })

// ---- zones ----
const zones = Command.make("zones", { json: jsonOpt }, ({ json }) =>
  RoonClient.pipe(
    Effect.flatMap((roon) =>
      Effect.if(json, {
        onTrue: () => roon.getZones.pipe(Effect.flatMap((zs) => Console.log(JSON.stringify(zs, null, 2)))),
        onFalse: () =>
          Console.log("Pairing with Roon (open Roon → Settings → Extensions → Enable 'STH DJ' if first run)…").pipe(
            Effect.flatMap(() => roon.getZones),
            Effect.flatMap((zs) =>
              zs.length === 0
                ? Console.log("No zones found.")
                : Effect.forEach(zs, (z) =>
                    Console.log(`${z.display_name} [${z.state}]\n  zone_id: ${z.zone_id}`)
                  )
            )
          )
      })
    )
  )
)

// ---- now ----
const formatNowPlaying = (z: RoonZone) =>
  Match.value(z.now_playing).pipe(
    Match.when({ three_line: Match.defined }, ({ three_line }) =>
      `  ${three_line.line1}\n  ${three_line.line2}\n  ${three_line.line3}`
    ),
    Match.when({ two_line: Match.defined }, ({ two_line }) =>
      `  ${two_line.line1} — ${two_line.line2}`
    ),
    Match.orElse(() => "  (nothing playing)")
  )

const now = Command.make("now", { zone: zoneOpt, json: jsonOpt }, ({ zone, json }) =>
  RoonClient.pipe(
    Effect.flatMap((roon) => roon.getZones),
    Effect.flatMap((zs) => pickZone(zs, zone)),
    Effect.flatMap((target) =>
      json
        ? Console.log(JSON.stringify(target, null, 2))
        : Console.log(`Zone: ${target.display_name} [${target.state}]\n${formatNowPlaying(target)}`)
    )
  )
)

// ---- play ----
const play = Command.make("play", { query: queryArg, zone: zoneOpt }, ({ query, zone }) =>
  Effect.gen(function* () {
    const roon = yield* RoonClient
    const sessions = yield* Sessions
    const zs = yield* roon.getZones
    const target = yield* pickZone(zs, zone)
    const resolved = yield* roon.searchAndPlay(target.zone_id, query)
    yield* sessions.append({ action: "play", zone: target.display_name, query, resolved })
    yield* Console.log(`▶ ${resolved}  →  ${target.display_name}`)
  })
)

// ---- transport controls ----
const transport = (action: TransportAction) =>
  Command.make(action, { zone: zoneOpt }, ({ zone }) =>
    RoonClient.pipe(
      Effect.flatMap((roon) =>
        roon.getZones.pipe(
          Effect.flatMap((zs) => pickZone(zs, zone)),
          Effect.flatMap((target) =>
            roon.control(target.zone_id, action).pipe(
              Effect.flatMap(() => Console.log(`${action} → ${target.display_name}`))
            )
          )
        )
      )
    )
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
    Effect.flatMap(
      Option.match({
        onNone: () => Console.log("no active session"),
        onSome: (s) => Console.log(`session ended: ${s.id}  (${s.entries.length} entries)`)
      })
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
    Sessions.pipe(
      Effect.flatMap((s) =>
        Option.match(id, {
          onNone: () => s.current,
          onSome: (id) => s.get(id).pipe(Effect.map(Option.some))
        })
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => (json ? Console.log("null") : Console.log("no session")),
          onSome: (s) =>
            json
              ? Console.log(JSON.stringify(s, null, 2))
              : Console.log(`${s.id}  ${s.name}`).pipe(
                  Effect.flatMap(() =>
                    Effect.forEach(s.entries, (e) =>
                      Console.log(`  [${e.ts}] ${e.action} ${e.zone}: ${e.resolved ?? e.query}`)
                    )
                  )
                )
        })
      )
    )
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
