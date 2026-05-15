import { Deferred, Effect, Match, MutableRef, Option, Ref, Schema } from "effect"
import { FileSystem } from "@effect/platform"
import RoonApi from "@roonlabs/node-roon-api"
import RoonApiTransport from "node-roon-api-transport"
import RoonApiBrowse from "node-roon-api-browse"
import RoonApiImage from "node-roon-api-image"
import RoonApiStatus from "node-roon-api-status"
import { ensureDir, fileExists, readJsonAs } from "./Config.ts"
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

export type BrowseItem = {
  title: string
  subtitle?: string
  item_key?: string
  hint?: string
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
}
type LoadOpts = { hierarchy: string; level?: number; offset?: number; count?: number }
type BrowseResponse = { action: "list" | "message" | "none"; message?: string }
type LoadResponse = { items: BrowseItem[]; offset: number; list: { count: number; level: number } }

const PersistedState = Schema.Record({ key: Schema.String, value: Schema.Unknown })
type PersistedState = Schema.Schema.Type<typeof PersistedState>

/**
 * FFI boundary with node-roon-api. The library is callback-based and exposes
 * synchronous getters (get_persisted_state) that can't be Effects, so we
 * confine the imperatives to one Effect.try wrapping the whole hand-off:
 *  - `state` lives in a MutableRef (synchronous read for the get callback)
 *  - `onPersist` is fired after every set so callers can flush to disk
 *  - `onPaired` is fired once the core completes the auth handshake
 */
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
    yield* ensureDir(paths.configDir).pipe(
      Effect.mapError((cause) => new RoonPairingFailed({ reason: `config dir: ${cause}` }))
    )

    const persistedRef = yield* Ref.make<PersistedState>({})

    // Load persisted token if present
    yield* fileExists(paths.roonStateFile).pipe(
      Effect.flatMap((exists) =>
        exists
          ? readJsonAs(paths.roonStateFile, PersistedState).pipe(
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
      // First caller owns startup
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

    // ---- callback wrapping helpers ----

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
        core.services.RoonApiTransport.control(zoneId, action, (msg) => {
          const matchResult = Match.value(msg).pipe(
            Match.when({ name: "Success" }, () => Effect.void),
            Match.when(undefined, () => Effect.void),
            Match.when(null, () => Effect.void),
            Match.orElse((m) =>
              Effect.fail(
                new RoonTransportFailed({ action, reason: JSON.stringify(m).slice(0, 200) })
              )
            )
          )
          resume(matchResult)
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

    const searchAndPlay = (zoneOrOutputId: string, query: string) =>
      Effect.gen(function* () {
        const core = yield* waitForCore
        const browseInZone = (opts: Omit<BrowseOpts, "hierarchy" | "zone_or_output_id">, stage: string) =>
          tryBrowse(
            core,
            { hierarchy: "browse", zone_or_output_id: zoneOrOutputId, ...opts },
            stage
          )
        const loadList = (stage: string) => tryLoad(core, { hierarchy: "browse" }, stage)

        // 1. Reset to root, find Search
        yield* browseInZone({ pop_all: true }, "open root")
        const root = (yield* loadList("load root")).items
        const searchEntry = root.find((i) => i.title.toLowerCase() === "search")
        if (!searchEntry?.item_key) {
          return yield* Effect.fail(
            new NoSearchResult({ query, hint: "Search entry not present in browse root" })
          )
        }

        // 2. Open Search prompt and submit query
        yield* browseInZone({ item_key: searchEntry.item_key }, "open search")
        yield* browseInZone({ input: query }, "submit query")
        const results = (yield* loadList("load results")).items

        // 3. Prefer Tracks section if present, else first playable
        const tracksSection = results.find((i) => i.title.toLowerCase() === "tracks")
        const candidate = yield* (tracksSection?.item_key
          ? browseInZone({ item_key: tracksSection.item_key }, "open tracks").pipe(
              Effect.flatMap(() => loadList("load tracks")),
              Effect.map((res) => res.items[0])
            )
          : Effect.succeed(results.find((i) => i.item_key)))
        if (!candidate?.item_key) {
          return yield* Effect.fail(
            new NoSearchResult({ query, hint: "no playable result for query" })
          )
        }

        // 4. Activate item, find a Play action, fire it
        yield* browseInZone({ item_key: candidate.item_key }, "open item")
        const actions = (yield* loadList("load actions")).items
        const playNow =
          actions.find((a) => a.title.toLowerCase().includes("play now")) ??
          actions.find((a) => a.title.toLowerCase().includes("play"))
        if (!playNow?.item_key) {
          return yield* Effect.fail(
            new NoSearchResult({ query, hint: `no Play action for "${candidate.title}"` })
          )
        }
        yield* browseInZone({ item_key: playNow.item_key }, "fire play")
        return candidate.title
      })

    return { waitForCore, getZones, findZone, control, searchAndPlay } as const
  })
}) {}
