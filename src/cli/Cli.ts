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
      return playing ? Effect.succeed(playing) : Effect.fail(new ZoneNotFound({ query: "<default>" }))
    },
    onSome: (q) => {
      const lower = q.toLowerCase()
      const match = zones.find(
        (z) => z.zone_id === q || z.display_name.toLowerCase().includes(lower)
      )
      return match ? Effect.succeed(match) : Effect.fail(new ZoneNotFound({ query: q }))
    }
  })

const withZone = <A, E, R>(
  zone: Option.Option<string>,
  body: (z: RoonZone) => Effect.Effect<A, E, R>
) =>
  RoonClient.pipe(
    Effect.flatMap((roon) => roon.getZones),
    Effect.flatMap((zs) => pickZone(zs, zone)),
    Effect.flatMap(body)
  )

// ---- zones ----
const zones = Command.make("zones", { json: jsonOpt }, ({ json }) =>
  RoonClient.pipe(
    Effect.flatMap((roon) =>
      json
        ? roon.getZones.pipe(Effect.flatMap((zs) => Console.log(JSON.stringify(zs, null, 2))))
        : Console.log(
            "Pairing with Roon (open Roon → Settings → Extensions → Enable 'STH DJ' if first run)…"
          ).pipe(
            Effect.flatMap(() => roon.getZones),
            Effect.flatMap((zs) =>
              zs.length === 0
                ? Console.log("No zones found.")
                : Effect.forEach(zs, (z) =>
                    Console.log(`${z.display_name} [${z.state}]\n  zone_id: ${z.zone_id}`)
                  )
            )
          )
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
  withZone(zone, (target) =>
    json
      ? Console.log(JSON.stringify(target, null, 2))
      : Console.log(`Zone: ${target.display_name} [${target.state}]\n${formatNowPlaying(target)}`)
  )
)

// ---- search-then-act commands ----
const playTrack = Command.make("play", { query: queryArg, zone: zoneOpt }, ({ query, zone }) =>
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

const queueTrack = Command.make("queue", { query: queryArg, zone: zoneOpt }, ({ query, zone }) =>
  Effect.gen(function* () {
    const roon = yield* RoonClient
    const sessions = yield* Sessions
    const zs = yield* roon.getZones
    const target = yield* pickZone(zs, zone)
    const resolved = yield* roon.searchAndQueue(target.zone_id, query)
    yield* sessions.append({ action: "queue", zone: target.display_name, query, resolved })
    yield* Console.log(`+ ${resolved}  →  ${target.display_name}`)
  })
)

const playNextTrack = Command.make("play-next", { query: queryArg, zone: zoneOpt }, ({ query, zone }) =>
  Effect.gen(function* () {
    const roon = yield* RoonClient
    const sessions = yield* Sessions
    const zs = yield* roon.getZones
    const target = yield* pickZone(zs, zone)
    const resolved = yield* roon.searchAndPlayNext(target.zone_id, query)
    yield* sessions.append({ action: "queue", zone: target.display_name, query, resolved, note: "play_next" })
    yield* Console.log(`↑ ${resolved}  →  ${target.display_name} (next)`)
  })
)

const playAlbum = Command.make("play-album", { query: queryArg, zone: zoneOpt }, ({ query, zone }) =>
  Effect.gen(function* () {
    const roon = yield* RoonClient
    const sessions = yield* Sessions
    const zs = yield* roon.getZones
    const target = yield* pickZone(zs, zone)
    const resolved = yield* roon.searchAlbumAndPlay(target.zone_id, query)
    yield* sessions.append({ action: "play", zone: target.display_name, query, resolved, note: "album" })
    yield* Console.log(`▶ album: ${resolved}  →  ${target.display_name}`)
  })
)

const queueAlbum = Command.make("queue-album", { query: queryArg, zone: zoneOpt }, ({ query, zone }) =>
  Effect.gen(function* () {
    const roon = yield* RoonClient
    const sessions = yield* Sessions
    const zs = yield* roon.getZones
    const target = yield* pickZone(zs, zone)
    const resolved = yield* roon.searchAlbumAndQueue(target.zone_id, query)
    yield* sessions.append({ action: "queue", zone: target.display_name, query, resolved, note: "album" })
    yield* Console.log(`+ album: ${resolved}  →  ${target.display_name}`)
  })
)

const playArtist = Command.make("play-artist", { query: queryArg, zone: zoneOpt }, ({ query, zone }) =>
  Effect.gen(function* () {
    const roon = yield* RoonClient
    const sessions = yield* Sessions
    const zs = yield* roon.getZones
    const target = yield* pickZone(zs, zone)
    const resolved = yield* roon.searchArtistAndPlay(target.zone_id, query)
    yield* sessions.append({ action: "play", zone: target.display_name, query, resolved, note: "artist" })
    yield* Console.log(`▶ artist: ${resolved}  →  ${target.display_name}`)
  })
)

// ---- transport ----
const transport = (action: TransportAction) =>
  Command.make(action, { zone: zoneOpt }, ({ zone }) =>
    withZone(zone, (target) =>
      RoonClient.pipe(
        Effect.flatMap((roon) => roon.control(target.zone_id, action)),
        Effect.flatMap(() => Console.log(`${action} → ${target.display_name}`))
      )
    )
  )

const seekCmd = Command.make(
  "seek",
  { seconds: Args.integer({ name: "seconds" }), zone: zoneOpt },
  ({ seconds, zone }) =>
    withZone(zone, (target) =>
      RoonClient.pipe(
        Effect.flatMap((roon) => roon.seek(target.zone_id, seconds)),
        Effect.flatMap(() => Console.log(`seek ${seconds}s → ${target.display_name}`))
      )
    )
)

const volumeCmd = Command.make(
  "volume",
  { value: Args.integer({ name: "value" }), zone: zoneOpt },
  ({ value, zone }) =>
    Effect.gen(function* () {
      const roon = yield* RoonClient
      const zs = yield* roon.getZones
      const target = yield* pickZone(zs, zone)
      const out = target.outputs?.[0]?.output_id
      if (!out) return yield* Effect.fail(new ZoneNotFound({ query: target.display_name }))
      yield* roon.setVolume(out, value)
      yield* Console.log(`volume ${value} → ${target.display_name}`)
    })
)

const muteCmd = Command.make(
  "mute",
  { zone: zoneOpt, off: Options.boolean("off").pipe(Options.withDefault(false)) },
  ({ zone, off }) =>
    Effect.gen(function* () {
      const roon = yield* RoonClient
      const zs = yield* roon.getZones
      const target = yield* pickZone(zs, zone)
      const out = target.outputs?.[0]?.output_id
      if (!out) return yield* Effect.fail(new ZoneNotFound({ query: target.display_name }))
      yield* roon.setMute(out, !off)
      yield* Console.log(`${off ? "unmute" : "mute"} → ${target.display_name}`)
    })
)

const shuffleCmd = Command.make(
  "shuffle",
  { zone: zoneOpt, off: Options.boolean("off").pipe(Options.withDefault(false)) },
  ({ zone, off }) =>
    withZone(zone, (target) =>
      RoonClient.pipe(
        Effect.flatMap((roon) => roon.changeSettings(target.zone_id, { shuffle: !off })),
        Effect.flatMap(() => Console.log(`shuffle ${off ? "off" : "on"} → ${target.display_name}`))
      )
    )
)

const radioCmd = Command.make(
  "radio",
  { zone: zoneOpt, off: Options.boolean("off").pipe(Options.withDefault(false)) },
  ({ zone, off }) =>
    withZone(zone, (target) =>
      RoonClient.pipe(
        Effect.flatMap((roon) => roon.changeSettings(target.zone_id, { auto_radio: !off })),
        Effect.flatMap(() => Console.log(`auto-radio ${off ? "off" : "on"} → ${target.display_name}`))
      )
    )
)

// ---- queue management ----
const queueListCmd = Command.make(
  "list",
  { zone: zoneOpt, json: jsonOpt },
  ({ zone, json }) =>
    withZone(zone, (target) =>
      RoonClient.pipe(
        Effect.flatMap((roon) => roon.getQueue(target.zone_id)),
        Effect.flatMap((items) =>
          json
            ? Console.log(JSON.stringify(items, null, 2))
            : items.length === 0
              ? Console.log(`(queue empty on ${target.display_name})`)
              : Effect.forEach(items, (it, i) => {
                  const tl = it.three_line ?? it.two_line ?? it.one_line
                  const line = tl
                    ? "line2" in (tl as object)
                      ? `${(tl as { line1: string; line2: string }).line1} — ${(tl as { line1: string; line2: string }).line2}`
                      : (tl as { line1: string }).line1
                    : `<#${it.queue_item_id}>`
                  return Console.log(`${i.toString().padStart(3)}. [${it.queue_item_id}] ${line}`)
                })
        )
      )
    )
)

const queueClearCmd = Command.make("clear", { zone: zoneOpt }, ({ zone }) =>
  Effect.gen(function* () {
    const roon = yield* RoonClient
    const zs = yield* roon.getZones
    const target = yield* pickZone(zs, zone)
    const out = target.outputs?.[0]?.output_id
    if (!out) return yield* Effect.fail(new ZoneNotFound({ query: target.display_name }))
    yield* roon.clearQueue(target.zone_id, out)
    yield* Console.log(`cleared queue → ${target.display_name}`)
  })
)

const queueJumpCmd = Command.make(
  "jump",
  { id: Args.integer({ name: "queue_item_id" }), zone: zoneOpt },
  ({ id, zone }) =>
    Effect.gen(function* () {
      const roon = yield* RoonClient
      const zs = yield* roon.getZones
      const target = yield* pickZone(zs, zone)
      const out = target.outputs?.[0]?.output_id
      if (!out) return yield* Effect.fail(new ZoneNotFound({ query: target.display_name }))
      yield* roon.playFromHere(out, id)
      yield* Console.log(`jump → queue_item_id=${id} on ${target.display_name}`)
    })
)

const queueGroup = Command.make("queue-mgr").pipe(
  Command.withSubcommands([queueListCmd, queueClearCmd, queueJumpCmd])
)

// ---- library ----
const libraryListCmd = (
  category: "Artists" | "Albums" | "Tracks" | "Composers" | "Tags",
  cmdName: string
) =>
  Command.make(
    cmdName,
    {
      zone: zoneOpt,
      limit: Options.integer("limit").pipe(Options.withDefault(50)),
      json: jsonOpt
    },
    ({ zone, limit, json }) =>
      withZone(zone, (target) =>
        RoonClient.pipe(
          Effect.flatMap((roon) => roon.listLibrary(target.zone_id, category, limit)),
          Effect.flatMap((items) =>
            json
              ? Console.log(JSON.stringify(items.map((i) => i.title), null, 2))
              : Effect.forEach(items, (i) => Console.log(i.title))
          )
        )
      )
  )

const library = Command.make("library").pipe(
  Command.withSubcommands([
    libraryListCmd("Artists", "artists"),
    libraryListCmd("Albums", "albums"),
    libraryListCmd("Tracks", "tracks"),
    libraryListCmd("Composers", "composers"),
    libraryListCmd("Tags", "tags")
  ])
)

// ---- playlists ----
const playlistsListCmd = Command.make("list", { zone: zoneOpt, json: jsonOpt }, ({ zone, json }) =>
  withZone(zone, (target) =>
    RoonClient.pipe(
      Effect.flatMap((roon) => roon.listPlaylists(target.zone_id)),
      Effect.flatMap((items) =>
        json
          ? Console.log(JSON.stringify(items.map((i) => i.title), null, 2))
          : Effect.forEach(items, (i) => Console.log(i.title))
      )
    )
  )
)

const playPlaylistCmd = Command.make(
  "play",
  { name: Args.text({ name: "name" }), zone: zoneOpt },
  ({ name, zone }) =>
    Effect.gen(function* () {
      const roon = yield* RoonClient
      const sessions = yield* Sessions
      const zs = yield* roon.getZones
      const target = yield* pickZone(zs, zone)
      const resolved = yield* roon.playPlaylistByName(target.zone_id, name)
      yield* sessions.append({
        action: "play",
        zone: target.display_name,
        query: name,
        resolved,
        note: "playlist"
      })
      yield* Console.log(`▶ playlist: ${resolved}  →  ${target.display_name}`)
    })
)

const playlists = Command.make("playlists").pipe(
  Command.withSubcommands([playlistsListCmd, playPlaylistCmd])
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
                      Console.log(
                        `  [${e.ts}] ${e.action}${e.note ? ` (${e.note})` : ""} ${e.zone}: ${e.resolved ?? e.query}`
                      )
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
    playTrack,
    queueTrack,
    playNextTrack,
    playAlbum,
    queueAlbum,
    playArtist,
    transport("pause"),
    transport("playpause"),
    transport("next"),
    transport("previous"),
    transport("stop"),
    seekCmd,
    volumeCmd,
    muteCmd,
    shuffleCmd,
    radioCmd,
    queueGroup,
    library,
    playlists,
    session
  ])
)

export const cli = Command.run(root, {
  name: "sth-dj",
  version: "0.0.1"
})
