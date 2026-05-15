import { Deferred, Effect, Match, MutableRef, Option, Ref, Schedule, Schema } from "effect"
import { FileSystem } from "@effect/platform"
import RoonApi from "@roonlabs/node-roon-api"
import RoonApiTransport from "node-roon-api-transport"
import RoonApiBrowse from "node-roon-api-browse"
import RoonApiImage from "node-roon-api-image"
import RoonApiStatus from "node-roon-api-status"
import { Paths } from "./Paths.ts"

// ---- public types ----

export type RoonZone = {
  zone_id: string
  display_name: string
  state: "playing" | "paused" | "stopped" | "loading"
  now_playing?: {
    seek_position?: number
    length?: number
    one_line?: { line1: string }
    two_line?: { line1: string; line2: string }
    three_line?: { line1: string; line2: string; line3: string }
  }
  outputs?: Array<{ output_id: string; display_name: string }>
}

export type TransportAction = "play" | "pause" | "playpause" | "stop" | "previous" | "next"
export type PlayMode = "play_now" | "queue" | "play_next"

export type BrowseItem = {
  title: string
  subtitle?: string
  item_key?: string
  hint?: string
}

export type QueueItem = {
  queue_item_id: number
  image_key?: string
  length?: number
  one_line?: { line1: string }
  two_line?: { line1: string; line2: string }
  three_line?: { line1: string; line2: string; line3: string }
}

// ---- errors ----

export class RoonPairingFailed extends Schema.TaggedError<RoonPairingFailed>()(
  "RoonPairingFailed",
  { reason: Schema.String }
) {}

export class RoonTransportFailed extends Schema.TaggedError<RoonTransportFailed>()(
  "RoonTransportFailed",
  { action: Schema.String, reason: Schema.String }
) {}

export class RoonBrowseFailed extends Schema.TaggedError<RoonBrowseFailed>()(
  "RoonBrowseFailed",
  { stage: Schema.String, reason: Schema.String }
) {}

export class ZoneNotFound extends Schema.TaggedError<ZoneNotFound>()(
  "ZoneNotFound",
  { query: Schema.String }
) {}

export class NoSearchResult extends Schema.TaggedError<NoSearchResult>()(
  "NoSearchResult",
  { query: Schema.String, hint: Schema.String }
) {}

// ---- internal node-roon-api shapes ----

type RawCore = {
  core_id: string
  display_name: string
  display_version: string
  services: {
    RoonApiTransport: {
      get_zones: (cb: (msg: unknown, body: { zones?: RoonZone[] }) => void) => void
      control: (zone: string, action: TransportAction, cb?: (msg: unknown) => void) => void
      seek: (
        zone: string,
        how: "relative" | "absolute",
        seconds: number,
        cb?: (msg: unknown) => void
      ) => void
      change_volume: (
        output: string,
        how: "absolute" | "relative" | "relative_step",
        value: number,
        cb?: (msg: unknown) => void
      ) => void
      mute: (output: string, how: "mute" | "unmute", cb?: (msg: unknown) => void) => void
      change_settings: (zone: string, settings: object, cb?: (msg: unknown) => void) => void
      play_from_here: (output: string, queue_item_id: number, cb?: (msg: unknown) => void) => void
      subscribe_queue: (
        zone: string,
        max: number,
        cb: (response: string, body: { items?: QueueItem[]; changes?: unknown }) => void
      ) => void
    }
    RoonApiBrowse: {
      browse: (opts: BrowseOpts, cb: (msg: unknown, body: BrowseResponse | undefined) => void) => void
      load: (opts: LoadOpts, cb: (msg: unknown, body: LoadResponse | undefined) => void) => void
    }
  }
}

type BrowseOpts = {
  hierarchy: string
  item_key?: string
  input?: string
  pop_all?: boolean
  zone_or_output_id?: string
  multi_session_key?: string
}
type LoadOpts = {
  hierarchy: string
  level?: number
  offset?: number
  count?: number
  multi_session_key?: string
}
type BrowseResponse = { action: "list" | "message" | "none"; message?: string }
type LoadResponse = { items: BrowseItem[]; offset: number; list: { count: number; level: number } }

const PersistedState = Schema.Record({ key: Schema.String, value: Schema.Unknown })
type PersistedState = Schema.Schema.Type<typeof PersistedState>

// ---- FFI bridge (sealed, see comment) ----

const acquireRoon = (
  initialState: PersistedState,
  onPersist: (s: PersistedState) => void,
  onPaired: (core: RawCore) => void
) =>
  Effect.try({
    try: () => {
      const state = MutableRef.make(initialState)
      const roon = new RoonApi({
        extension_id: "com.sth.dj",
        display_name: "STH DJ",
        display_version: "0.0.1",
        publisher: "sth",
        email: "shane.keulen@gmail.com",
        log_level: "none",
        set_persisted_state: (s: PersistedState) => {
          MutableRef.set(state, s)
          onPersist(s)
        },
        get_persisted_state: () => MutableRef.get(state),
        core_paired: (core: unknown) => onPaired(core as RawCore),
        core_unpaired: () => {}
      })
      ;(roon as unknown as {
        init_services: (o: { required_services: unknown[]; provided_services: unknown[] }) => void
      }).init_services({
        required_services: [RoonApiTransport, RoonApiBrowse, RoonApiImage],
        provided_services: []
      })
      new RoonApiStatus(roon).set_status("Idle", false)
      roon.start_discovery()
    },
    catch: (cause) => new RoonPairingFailed({ reason: String(cause) })
  })

// ---- service ----

export class RoonClient extends Effect.Service<RoonClient>()("sth-dj/RoonClient", {
  effect: Effect.gen(function* () {
    const paths = yield* Paths
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(paths.configDir, { recursive: true }).pipe(
      Effect.mapError((cause) => new RoonPairingFailed({ reason: `config dir: ${cause}` }))
    )

    const persistedRef = yield* Ref.make<PersistedState>({})
    yield* fs.exists(paths.roonStateFile).pipe(
      Effect.orElseSucceed(() => false),
      Effect.flatMap((exists) =>
        exists
          ? fs.readFileString(paths.roonStateFile).pipe(
              Effect.flatMap((txt) =>
                Effect.try({
                  try: () => JSON.parse(txt) as PersistedState,
                  catch: () => null
                }).pipe(Effect.catchAll(() => Effect.succeed({} as PersistedState)))
              ),
              Effect.flatMap((s) => Ref.set(persistedRef, s)),
              Effect.catchAll(() => Effect.void)
            )
          : Effect.void
      )
    )

    const startedRef = yield* Ref.make<Option.Option<Deferred.Deferred<RawCore, RoonPairingFailed>>>(
      Option.none()
    )

    const ensureStarted = Effect.gen(function* () {
      const existing = yield* Ref.get(startedRef)
      if (Option.isSome(existing)) return existing.value
      const deferred = yield* Deferred.make<RawCore, RoonPairingFailed>()
      const updated = yield* Ref.modify(startedRef, (current) =>
        Option.isSome(current) ? [current.value, current] : [deferred, Option.some(deferred)]
      )
      if (updated === deferred) {
        const initial = yield* Ref.get(persistedRef)
        const persist = (s: PersistedState) =>
          Ref.set(persistedRef, s).pipe(
            Effect.flatMap(() =>
              fs.writeFileString(paths.roonStateFile, JSON.stringify(s, null, 2))
            ),
            Effect.catchAll(() => Effect.void)
          )
        yield* acquireRoon(
          initial,
          (s) => Effect.runFork(persist(s)),
          (core) => Effect.runFork(Deferred.succeed(deferred, core))
        ).pipe(Effect.tapError((err) => Deferred.fail(deferred, err)))
      }
      return updated
    })

    const waitForCore = ensureStarted.pipe(Effect.flatMap(Deferred.await))

    // ---- callback wrappers ----

    const successOrFail = (action: string) => (msg: unknown) =>
      Match.value(msg).pipe(
        Match.when({ name: "Success" }, () => Effect.void),
        Match.when(undefined, () => Effect.void),
        Match.when(null, () => Effect.void),
        Match.orElse((m) =>
          Effect.fail(
            new RoonTransportFailed({ action, reason: JSON.stringify(m).slice(0, 200) })
          )
        )
      )

    const tryGetZones = (core: RawCore) =>
      Effect.async<RoonZone[], RoonTransportFailed>((resume) => {
        core.services.RoonApiTransport.get_zones((_msg, body) => {
          if (!body?.zones) {
            resume(
              Effect.fail(
                new RoonTransportFailed({ action: "get_zones", reason: "no zones in response" })
              )
            )
            return
          }
          resume(Effect.succeed(body.zones))
        })
      })

    const tryControl = (core: RawCore, zoneId: string, action: TransportAction) =>
      Effect.async<void, RoonTransportFailed>((resume) => {
        core.services.RoonApiTransport.control(zoneId, action, (msg) =>
          resume(successOrFail(action)(msg))
        )
      })

    const trySeek = (core: RawCore, zoneId: string, seconds: number, mode: "absolute" | "relative") =>
      Effect.async<void, RoonTransportFailed>((resume) => {
        core.services.RoonApiTransport.seek(zoneId, mode, seconds, (msg) =>
          resume(successOrFail(`seek ${mode}`)(msg))
        )
      })

    const tryChangeVolume = (core: RawCore, outputId: string, value: number, mode: "absolute" | "relative" | "relative_step") =>
      Effect.async<void, RoonTransportFailed>((resume) => {
        core.services.RoonApiTransport.change_volume(outputId, mode, value, (msg) =>
          resume(successOrFail(`volume ${mode}`)(msg))
        )
      })

    const tryMute = (core: RawCore, outputId: string, on: boolean) =>
      Effect.async<void, RoonTransportFailed>((resume) => {
        core.services.RoonApiTransport.mute(outputId, on ? "mute" : "unmute", (msg) =>
          resume(successOrFail(on ? "mute" : "unmute")(msg))
        )
      })

    const tryChangeSettings = (core: RawCore, zoneId: string, settings: object) =>
      Effect.async<void, RoonTransportFailed>((resume) => {
        core.services.RoonApiTransport.change_settings(zoneId, settings, (msg) =>
          resume(successOrFail("change_settings")(msg))
        )
      })

    const tryPlayFromHere = (core: RawCore, outputId: string, queueItemId: number) =>
      Effect.async<void, RoonTransportFailed>((resume) => {
        core.services.RoonApiTransport.play_from_here(outputId, queueItemId, (msg) =>
          resume(successOrFail("play_from_here")(msg))
        )
      })

    /**
     * Subscribe just long enough to capture one queue snapshot, then unsubscribe.
     * The Roon transport pushes initial items on subscription.
     */
    const tryGetQueue = (core: RawCore, zoneOrOutputId: string, max: number) =>
      Effect.async<QueueItem[], RoonTransportFailed>((resume) => {
        core.services.RoonApiTransport.subscribe_queue(zoneOrOutputId, max, (response, body) => {
          if (response === "Subscribed" && body.items) {
            resume(Effect.succeed(body.items))
          }
        })
      })

    const tryBrowse = (core: RawCore, opts: BrowseOpts, stage: string) =>
      Effect.async<BrowseResponse, RoonBrowseFailed>((resume) => {
        core.services.RoonApiBrowse.browse(opts, (_msg, body) => {
          if (!body) {
            resume(Effect.fail(new RoonBrowseFailed({ stage, reason: "empty browse response" })))
            return
          }
          resume(Effect.succeed(body))
        })
      })

    const tryLoad = (core: RawCore, opts: LoadOpts, stage: string) =>
      Effect.async<LoadResponse, RoonBrowseFailed>((resume) => {
        core.services.RoonApiBrowse.load(opts, (_msg, body) => {
          if (!body) {
            resume(Effect.fail(new RoonBrowseFailed({ stage, reason: "empty load response" })))
            return
          }
          resume(Effect.succeed(body))
        })
      })

    // ---- public API ----

    const getZones = waitForCore.pipe(Effect.flatMap(tryGetZones))

    const findZone = (query: string) =>
      getZones.pipe(
        Effect.flatMap((zones) => {
          const lower = query.toLowerCase()
          const match = zones.find(
            (z) =>
              z.zone_id === query ||
              z.display_name.toLowerCase() === lower ||
              z.display_name.toLowerCase().includes(lower)
          )
          return match ? Effect.succeed(match) : Effect.fail(new ZoneNotFound({ query }))
        })
      )

    const control = (zoneId: string, action: TransportAction) =>
      waitForCore.pipe(Effect.flatMap((core) => tryControl(core, zoneId, action)))

    const seek = (zoneId: string, seconds: number, mode: "absolute" | "relative" = "absolute") =>
      waitForCore.pipe(Effect.flatMap((core) => trySeek(core, zoneId, seconds, mode)))

    const setVolume = (outputId: string, value: number, mode: "absolute" | "relative" | "relative_step" = "absolute") =>
      waitForCore.pipe(Effect.flatMap((core) => tryChangeVolume(core, outputId, value, mode)))

    const setMute = (outputId: string, on: boolean) =>
      waitForCore.pipe(Effect.flatMap((core) => tryMute(core, outputId, on)))

    const changeSettings = (zoneId: string, settings: { shuffle?: boolean; loop?: "loop" | "loop_one" | "disabled"; auto_radio?: boolean }) =>
      waitForCore.pipe(Effect.flatMap((core) => tryChangeSettings(core, zoneId, settings)))

    const getQueue = (zoneOrOutputId: string, max = 200) =>
      waitForCore.pipe(Effect.flatMap((core) => tryGetQueue(core, zoneOrOutputId, max)))

    const playFromHere = (outputId: string, queueItemId: number) =>
      waitForCore.pipe(Effect.flatMap((core) => tryPlayFromHere(core, outputId, queueItemId)))

    /**
     * Heuristic queue-clear: queue + skip past every item except the now-playing one,
     * then optionally pause. Roon has no first-class clear; replace via a fresh Play Now
     * is the supported way. This best-effort variant is safe to call.
     */
    const clearQueue = (zoneId: string, outputId: string) =>
      Effect.gen(function* () {
        const items = yield* getQueue(zoneId, 1000)
        if (items.length === 0) return
        const last = items[items.length - 1]
        if (last) yield* playFromHere(outputId, last.queue_item_id).pipe(Effect.ignore)
        yield* control(zoneId, "stop").pipe(Effect.ignore)
      })

    // ---- search ----

    const actionMatchers: Record<PlayMode, (title: string) => boolean> = {
      play_now: (t) => t.includes("play now") || t === "play",
      queue: (t) => (t.includes("queue") || t.includes("add to queue")) && !t.includes("clear"),
      play_next: (t) => t.includes("play next") || t.includes("add next")
    }

    type SearchSection = "Tracks" | "Albums" | "Artists" | "Composers" | "Works"

    /**
     * Submits a search via the dedicated `hierarchy: "search"`, drills into the
     * requested section (default Tracks), picks the first item, then activates
     * the action matching `mode`.
     */
    const searchAndAct = (
      zoneOrOutputId: string,
      query: string,
      mode: PlayMode,
      section: SearchSection = "Tracks"
    ) =>
      Effect.gen(function* () {
        const core = yield* waitForCore
        const inSearch = (opts: Partial<BrowseOpts>, stage: string) =>
          tryBrowse(
            core,
            { hierarchy: "search", zone_or_output_id: zoneOrOutputId, ...opts },
            stage
          )
        const loadHere = (stage: string) => tryLoad(core, { hierarchy: "search" }, stage)

        // 1. Submit search
        yield* inSearch({ pop_all: true, input: query }, "submit search")
        const sectionsRes = yield* loadHere("load search root")
        const sectionItem = sectionsRes.items.find((i) => i.title === section)
        if (!sectionItem?.item_key) {
          return yield* Effect.fail(
            new NoSearchResult({ query, hint: `no ${section} section in search results` })
          )
        }

        // 2. Drill into section
        yield* inSearch({ item_key: sectionItem.item_key }, `open ${section}`)
        const items = (yield* loadHere(`load ${section}`)).items
        const candidate = items.find((i) => i.item_key)
        if (!candidate?.item_key) {
          return yield* Effect.fail(
            new NoSearchResult({ query, hint: `no playable item in ${section}` })
          )
        }

        // 3. Drill until we hit an action menu (items with hint: "action").
        //    Roon represents track items with hint "action_list" — clicking one
        //    yields a wrapper level with another action_list before the actual
        //    actions appear. Keep drilling on single-action_list responses up to
        //    a small depth to avoid infinite loops.
        let currentKey = candidate.item_key
        let actionItems: BrowseItem[] = []
        for (let depth = 0; depth < 4; depth++) {
          yield* inSearch({ item_key: currentKey }, `drill depth ${depth}`)
          const loaded = yield* loadHere(`load depth ${depth}`)
          const allActions = loaded.items.length > 0 && loaded.items.every((i) => i.hint === "action")
          if (allActions) {
            actionItems = loaded.items
            break
          }
          const next = loaded.items.find((i) => i.item_key)
          if (!next?.item_key) break
          currentKey = next.item_key
        }
        if (actionItems.length === 0) {
          return yield* Effect.fail(
            new NoSearchResult({
              query,
              hint: `couldn't reach action menu for "${candidate.title}"`
            })
          )
        }

        // 4. Match and fire action
        const matcher = actionMatchers[mode]
        const action = actionItems.find((a) => matcher(a.title.toLowerCase()))
        if (!action?.item_key) {
          return yield* Effect.fail(
            new NoSearchResult({
              query,
              hint: `no ${mode} action for "${candidate.title}". available: ${actionItems.map((a) => a.title).join(", ")}`
            })
          )
        }
        yield* inSearch({ item_key: action.item_key }, `fire ${mode}`)
        return candidate.title
      })

    /**
     * The Roon ws transport occasionally returns an empty response for the very
     * first browse call after a fresh pair (closes the moo connection mid-flight).
     * Retry transport-failed browses up to 3x with backoff.
     */
    const searchPolicy = Schedule.exponential("400 millis").pipe(
      Schedule.intersect(Schedule.recurs(3))
    )
    const withRetry = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
      eff.pipe(
        Effect.retry({
          schedule: searchPolicy,
          while: (e) =>
            (e as { _tag?: string; reason?: string })._tag === "RoonBrowseFailed" &&
            (e as { reason: string }).reason.includes("empty")
        })
      )

    const searchAndPlay = (zoneOrOutputId: string, query: string) =>
      withRetry(searchAndAct(zoneOrOutputId, query, "play_now", "Tracks"))
    const searchAndQueue = (zoneOrOutputId: string, query: string) =>
      withRetry(searchAndAct(zoneOrOutputId, query, "queue", "Tracks"))
    const searchAndPlayNext = (zoneOrOutputId: string, query: string) =>
      withRetry(searchAndAct(zoneOrOutputId, query, "play_next", "Tracks"))
    const searchAlbumAndPlay = (zoneOrOutputId: string, query: string) =>
      withRetry(searchAndAct(zoneOrOutputId, query, "play_now", "Albums"))
    const searchAlbumAndQueue = (zoneOrOutputId: string, query: string) =>
      withRetry(searchAndAct(zoneOrOutputId, query, "queue", "Albums"))
    const searchArtistAndPlay = (zoneOrOutputId: string, query: string) =>
      withRetry(searchAndAct(zoneOrOutputId, query, "play_now", "Artists"))

    // ---- library browse ----

    type LibraryCategory = "Artists" | "Albums" | "Tracks" | "Composers" | "Tags"

    /**
     * Lists items in a Library category. Returns up to `limit` titles.
     */
    const listLibrary = (zoneOrOutputId: string, category: LibraryCategory, limit = 100) =>
      Effect.gen(function* () {
        const core = yield* waitForCore
        const opts = (extra: Partial<BrowseOpts>) =>
          ({
            hierarchy: "browse" as const,
            zone_or_output_id: zoneOrOutputId,
            ...extra
          })
        yield* tryBrowse(core, opts({ pop_all: true }), "open root")
        const root = (yield* tryLoad(core, { hierarchy: "browse" }, "load root")).items
        const lib = root.find((i) => i.title === "Library")
        if (!lib?.item_key) {
          return yield* Effect.fail(new RoonBrowseFailed({ stage: "find Library", reason: "missing" }))
        }
        yield* tryBrowse(core, opts({ item_key: lib.item_key }), "open Library")
        const libItems = (yield* tryLoad(core, { hierarchy: "browse" }, "load Library")).items
        const cat = libItems.find((i) => i.title === category)
        if (!cat?.item_key) {
          return yield* Effect.fail(
            new RoonBrowseFailed({ stage: `find ${category}`, reason: "missing" })
          )
        }
        yield* tryBrowse(core, opts({ item_key: cat.item_key }), `open ${category}`)
        const out = (yield* tryLoad(core, { hierarchy: "browse", count: limit }, `load ${category}`))
          .items
        return out.filter((i) => i.title !== "..").slice(0, limit)
      })

    // ---- playlists ----

    const listPlaylists = (zoneOrOutputId: string, limit = 100) =>
      Effect.gen(function* () {
        const core = yield* waitForCore
        const opts = (extra: Partial<BrowseOpts>) =>
          ({
            hierarchy: "browse" as const,
            zone_or_output_id: zoneOrOutputId,
            ...extra
          })
        yield* tryBrowse(core, opts({ pop_all: true }), "open root")
        const root = (yield* tryLoad(core, { hierarchy: "browse" }, "load root")).items
        const pl = root.find((i) => i.title === "Playlists")
        if (!pl?.item_key) {
          return yield* Effect.fail(
            new RoonBrowseFailed({ stage: "find Playlists", reason: "missing" })
          )
        }
        yield* tryBrowse(core, opts({ item_key: pl.item_key }), "open Playlists")
        const out = (yield* tryLoad(core, { hierarchy: "browse", count: limit }, "load Playlists"))
          .items
        return out
      })

    const playPlaylistByName = (zoneOrOutputId: string, name: string) =>
      Effect.gen(function* () {
        const playlists = yield* listPlaylists(zoneOrOutputId, 500)
        const lower = name.toLowerCase()
        const match =
          playlists.find((p) => p.title.toLowerCase() === lower) ??
          playlists.find((p) => p.title.toLowerCase().includes(lower))
        if (!match?.item_key) {
          return yield* Effect.fail(
            new NoSearchResult({ query: name, hint: "no matching playlist" })
          )
        }
        const core = yield* waitForCore
        const opts = (extra: Partial<BrowseOpts>) =>
          ({ hierarchy: "browse" as const, zone_or_output_id: zoneOrOutputId, ...extra })
        yield* tryBrowse(core, opts({ item_key: match.item_key }), "open playlist")
        const actions = (yield* tryLoad(core, { hierarchy: "browse" }, "load playlist actions")).items
        const playNow = actions.find((a) => a.title.toLowerCase().includes("play now"))
        if (!playNow?.item_key) {
          return yield* Effect.fail(
            new NoSearchResult({ query: name, hint: "no Play Now action on playlist" })
          )
        }
        yield* tryBrowse(core, opts({ item_key: playNow.item_key }), "fire play playlist")
        return match.title
      })

    return {
      waitForCore,
      getZones,
      findZone,
      control,
      seek,
      setVolume,
      setMute,
      changeSettings,
      getQueue,
      playFromHere,
      clearQueue,
      searchAndPlay,
      searchAndQueue,
      searchAndPlayNext,
      searchAlbumAndPlay,
      searchAlbumAndQueue,
      searchArtistAndPlay,
      listLibrary,
      listPlaylists,
      playPlaylistByName
    } as const
  })
}) {}
