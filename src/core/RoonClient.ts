import { Context, Effect, Layer } from "effect"
import RoonApi from "@roonlabs/node-roon-api"
import RoonApiTransport from "node-roon-api-transport"
import RoonApiBrowse from "node-roon-api-browse"
import RoonApiImage from "node-roon-api-image"
import RoonApiStatus from "node-roon-api-status"
import { ensureConfigDir, readJson, roonStateFile, writeJson } from "./Config.ts"

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

export type RoonCore = {
  core_id: string
  display_name: string
  display_version: string
  services: {
    RoonApiTransport: {
      get_zones: (cb: (msg: unknown, body: { zones: RoonZone[] }) => void) => void
      subscribe_zones: (cb: (response: string, body: { zones?: RoonZone[]; zones_changed?: RoonZone[] }) => void) => void
      control: (zone: string, action: "play" | "pause" | "playpause" | "stop" | "previous" | "next", cb?: (msg: unknown) => void) => void
    }
    RoonApiBrowse: {
      browse: (
        opts: { hierarchy: string; item_key?: string; input?: string; pop_all?: boolean; multi_session_key?: string; zone_or_output_id?: string },
        cb: (msg: unknown, body: BrowseResponse) => void
      ) => void
      load: (
        opts: { hierarchy: string; level?: number; offset?: number; count?: number; multi_session_key?: string },
        cb: (msg: unknown, body: LoadResponse) => void
      ) => void
    }
  }
}

export type BrowseItem = {
  title: string
  subtitle?: string
  item_key?: string
  hint?: string
  input_prompt?: { prompt: string; action: string; value?: string }
}

export type BrowseResponse = {
  action: "list" | "message" | "none" | "replace_item" | "remove_item"
  list?: { title: string; count: number; level: number; display_offset?: number }
  item?: BrowseItem
  message?: string
}

export type LoadResponse = {
  items: BrowseItem[]
  offset: number
  list: { title: string; count: number; level: number }
}

export class RoonClient extends Context.Tag("sth-dj/RoonClient")<
  RoonClient,
  {
    readonly waitForCore: Effect.Effect<RoonCore, Error>
    readonly getZones: Effect.Effect<RoonZone[], Error>
    readonly findZone: (nameOrId: string) => Effect.Effect<RoonZone, Error>
    readonly control: (
      zoneId: string,
      action: "play" | "pause" | "playpause" | "stop" | "previous" | "next"
    ) => Effect.Effect<void, Error>
    readonly browseHome: (zoneOrOutputId?: string) => Effect.Effect<BrowseItem[], Error>
    readonly browseInto: (itemKey: string, zoneOrOutputId?: string) => Effect.Effect<BrowseItem[], Error>
    readonly searchAndPlay: (zoneOrOutputId: string, query: string) => Effect.Effect<string, Error>
  }
>() {}

type PersistedState = Record<string, unknown>

const make = Effect.gen(function* () {
  yield* ensureConfigDir
  const persisted = yield* readJson<PersistedState>(roonStateFile)
  let state: PersistedState = persisted ?? {}

  let started = false
  let corePromise: Promise<RoonCore> | null = null

  const ensureStarted = () => {
    if (started) return corePromise!
    started = true
    let resolveCore!: (c: RoonCore) => void
    corePromise = new Promise<RoonCore>((res) => {
      resolveCore = res
    })
    const roon = new RoonApi({
      extension_id: "com.sth.dj",
      display_name: "STH DJ",
      display_version: "0.0.1",
      publisher: "sth",
      email: "shane.keulen@gmail.com",
      log_level: "none",
      set_persisted_state: (s: PersistedState) => {
        state = s
        void writeJson(roonStateFile, state).pipe(Effect.runPromise)
      },
      get_persisted_state: () => state,
      core_paired: (core: unknown) => {
        resolveCore(core as RoonCore)
      },
      core_unpaired: () => {}
    })
    ;(roon as unknown as { init_services: (o: { required_services: unknown[]; provided_services: unknown[] }) => void }).init_services({
      required_services: [RoonApiTransport, RoonApiBrowse, RoonApiImage],
      provided_services: []
    })
    const status = new RoonApiStatus(roon)
    status.set_status("Idle", false)
    roon.start_discovery()
    return corePromise
  }

  const waitForCore = Effect.tryPromise({
    try: () => ensureStarted(),
    catch: (cause) => new Error(`failed to pair Roon core: ${cause}`)
  })

  const getZones = Effect.flatMap(waitForCore, (core) =>
    Effect.async<RoonZone[], Error>((resume) => {
      core.services.RoonApiTransport.get_zones((_msg, body) => {
        if (!body || !Array.isArray(body.zones)) {
          resume(Effect.fail(new Error("no zones in transport response")))
          return
        }
        resume(Effect.succeed(body.zones))
      })
    })
  )

  const findZone = (nameOrId: string) =>
    Effect.flatMap(getZones, (zones) => {
      const lower = nameOrId.toLowerCase()
      const match = zones.find(
        (z) =>
          z.zone_id === nameOrId ||
          z.display_name.toLowerCase() === lower ||
          z.display_name.toLowerCase().includes(lower)
      )
      return match ? Effect.succeed(match) : Effect.fail(new Error(`zone not found: ${nameOrId}`))
    })

  const control = (
    zoneId: string,
    action: "play" | "pause" | "playpause" | "stop" | "previous" | "next"
  ) =>
    Effect.flatMap(waitForCore, (core) =>
      Effect.async<void, Error>((resume) => {
        core.services.RoonApiTransport.control(zoneId, action, (msg) => {
          if (msg && typeof msg === "object" && "name" in msg && (msg as { name?: string }).name === "Success") {
            resume(Effect.void)
          } else if (!msg) {
            resume(Effect.void)
          } else {
            resume(Effect.fail(new Error(`transport ${action} failed: ${JSON.stringify(msg)}`)))
          }
        })
      })
    )

  const browseRaw = (
    opts: Parameters<RoonCore["services"]["RoonApiBrowse"]["browse"]>[0]
  ) =>
    Effect.flatMap(waitForCore, (core) =>
      Effect.async<BrowseResponse, Error>((resume) => {
        core.services.RoonApiBrowse.browse(opts, (_msg, body) => {
          if (!body) {
            resume(Effect.fail(new Error("empty browse response")))
            return
          }
          resume(Effect.succeed(body))
        })
      })
    )

  const loadRaw = (
    opts: Parameters<RoonCore["services"]["RoonApiBrowse"]["load"]>[0]
  ) =>
    Effect.flatMap(waitForCore, (core) =>
      Effect.async<LoadResponse, Error>((resume) => {
        core.services.RoonApiBrowse.load(opts, (_msg, body) => {
          if (!body) {
            resume(Effect.fail(new Error("empty load response")))
            return
          }
          resume(Effect.succeed(body))
        })
      })
    )

  const browseHome = (zoneOrOutputId?: string) =>
    Effect.gen(function* () {
      const browseOpts: Parameters<typeof browseRaw>[0] = { hierarchy: "browse", pop_all: true }
      if (zoneOrOutputId !== undefined) browseOpts.zone_or_output_id = zoneOrOutputId
      yield* browseRaw(browseOpts)
      const loaded = yield* loadRaw({ hierarchy: "browse" })
      return loaded.items
    })

  const browseInto = (itemKey: string, zoneOrOutputId?: string) =>
    Effect.gen(function* () {
      const browseOpts: Parameters<typeof browseRaw>[0] = { hierarchy: "browse", item_key: itemKey }
      if (zoneOrOutputId !== undefined) browseOpts.zone_or_output_id = zoneOrOutputId
      yield* browseRaw(browseOpts)
      const loaded = yield* loadRaw({ hierarchy: "browse" })
      return loaded.items
    })

  const searchAndPlay = (zoneOrOutputId: string, query: string) =>
    Effect.gen(function* () {
      // Reset to root, find Search entry
      yield* browseRaw({ hierarchy: "browse", pop_all: true, zone_or_output_id: zoneOrOutputId })
      const home = (yield* loadRaw({ hierarchy: "browse" })).items
      const searchEntry = home.find((i) => i.title.toLowerCase() === "search")
      if (!searchEntry?.item_key) return yield* Effect.fail(new Error("Search entry not found in Roon browse"))

      // Open Search prompt
      yield* browseRaw({ hierarchy: "browse", item_key: searchEntry.item_key, zone_or_output_id: zoneOrOutputId })
      // Submit the query
      yield* browseRaw({ hierarchy: "browse", input: query, zone_or_output_id: zoneOrOutputId })
      const results = (yield* loadRaw({ hierarchy: "browse" })).items

      // Look for a "Tracks" section first; otherwise pick the first playable item
      const tracksSection = results.find((i) => i.title.toLowerCase() === "tracks")
      let candidate: BrowseItem | undefined
      if (tracksSection?.item_key) {
        yield* browseRaw({ hierarchy: "browse", item_key: tracksSection.item_key, zone_or_output_id: zoneOrOutputId })
        const trackItems = (yield* loadRaw({ hierarchy: "browse" })).items
        candidate = trackItems[0]
      } else {
        candidate = results.find((i) => i.item_key)
      }
      if (!candidate?.item_key) return yield* Effect.fail(new Error(`no playable result for "${query}"`))

      // Activate the item to get its action menu (Play Now etc.)
      yield* browseRaw({ hierarchy: "browse", item_key: candidate.item_key, zone_or_output_id: zoneOrOutputId })
      const actions = (yield* loadRaw({ hierarchy: "browse" })).items
      const playNow = actions.find((a) => a.title.toLowerCase().includes("play now")) ?? actions.find((a) => a.title.toLowerCase().includes("play"))
      if (!playNow?.item_key) return yield* Effect.fail(new Error(`no Play action available for "${candidate.title}"`))

      yield* browseRaw({ hierarchy: "browse", item_key: playNow.item_key, zone_or_output_id: zoneOrOutputId })
      return candidate.title
    })

  return RoonClient.of({
    waitForCore,
    getZones,
    findZone,
    control,
    browseHome,
    browseInto,
    searchAndPlay
  })
})

export const RoonClientLive = Layer.effect(RoonClient, make)
