import { Effect, Schema, Option } from "effect"
import { FileSystem } from "@effect/platform"
import { Paths } from "./Paths.ts"

// ---- schema ----

export const SessionEntry = Schema.Struct({
  ts: Schema.String,
  action: Schema.Literal("play", "queue"),
  zone: Schema.String,
  query: Schema.String,
  resolved: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String)
})
export type SessionEntry = Schema.Schema.Type<typeof SessionEntry>

export const Session = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  startedAt: Schema.String,
  endedAt: Schema.optional(Schema.String),
  entries: Schema.Array(SessionEntry)
})
export type Session = Schema.Schema.Type<typeof Session>

const Pointer = Schema.Struct({ id: Schema.String })

// ---- errors (per-service) ----

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  { id: Schema.String }
) {}

export class SessionPersistError extends Schema.TaggedError<SessionPersistError>()(
  "SessionPersistError",
  { op: Schema.String, reason: Schema.String }
) {}

export class SessionDecodeError extends Schema.TaggedError<SessionDecodeError>()(
  "SessionDecodeError",
  { what: Schema.String, reason: Schema.String }
) {}

// ---- helpers ----

const newId = Effect.sync(() => {
  const d = new Date()
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
})

const nowIso = Effect.sync(() => new Date().toISOString())

const mapPersist = (op: string) =>
  <A, R>(eff: Effect.Effect<A, unknown, R>) =>
    eff.pipe(Effect.mapError((cause) => new SessionPersistError({ op, reason: String(cause) })))

const mapDecode = (what: string) =>
  <A, R>(eff: Effect.Effect<A, unknown, R>) =>
    eff.pipe(Effect.mapError((cause) => new SessionDecodeError({ what, reason: String(cause) })))

// ---- service ----

export class Sessions extends Effect.Service<Sessions>()("sth-dj/Sessions", {
  effect: Effect.gen(function* () {
    const paths = yield* Paths
    const fs = yield* FileSystem.FileSystem

    yield* fs.makeDirectory(paths.configDir, { recursive: true }).pipe(mapPersist("ensure config dir"))
    yield* fs.makeDirectory(paths.sessionsDir, { recursive: true }).pipe(mapPersist("ensure sessions dir"))

    const sessionFile = (id: string) => `${paths.sessionsDir}/${id}.json`

    const readJsonFile = <A, I>(file: string, schema: Schema.Schema<A, I>, what: string) =>
      fs.readFileString(file).pipe(
        Effect.flatMap((text) =>
          Effect.try({
            try: () => JSON.parse(text) as unknown,
            catch: (cause) => new SessionDecodeError({ what, reason: `invalid JSON: ${cause}` })
          })
        ),
        Effect.flatMap((parsed) =>
          Schema.decodeUnknown(schema)(parsed).pipe(
            Effect.mapError((e) => new SessionDecodeError({ what, reason: String(e) }))
          )
        )
      )

    const readSession = (id: string) =>
      readJsonFile(sessionFile(id), Session, `session ${id}`).pipe(
        Effect.catchTag("SystemError", () => new SessionNotFound({ id })),
        Effect.catchTag("BadArgument", () => new SessionNotFound({ id }))
      )

    const writeSession = (s: Session) =>
      fs.writeFileString(sessionFile(s.id), JSON.stringify(s, null, 2)).pipe(
        mapPersist(`write session ${s.id}`)
      )

    const readPointer = fs.exists(paths.pointerFile).pipe(
      Effect.orElseSucceed(() => false),
      Effect.flatMap((exists) =>
        exists
          ? readJsonFile(paths.pointerFile, Pointer, "pointer").pipe(
              Effect.map((p) => Option.some(p.id))
            )
          : Effect.succeed(Option.none<string>())
      )
    )

    const writePointer = (id: Option.Option<string>) =>
      Option.match(id, {
        onNone: () => fs.remove(paths.pointerFile, { force: true }).pipe(mapPersist("clear pointer")),
        onSome: (id) =>
          fs.writeFileString(paths.pointerFile, JSON.stringify({ id }, null, 2)).pipe(
            mapPersist("write pointer")
          )
      })

    const start = (name: string) =>
      Effect.all({ id: newId, startedAt: nowIso }).pipe(
        Effect.map(({ id, startedAt }): Session => ({ id, name, startedAt, entries: [] })),
        Effect.tap(writeSession),
        Effect.tap((s) => writePointer(Option.some(s.id)))
      )

    const current = readPointer.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<Session>()),
          onSome: (id) => readSession(id).pipe(Effect.map(Option.some))
        })
      )
    )

    const end = current.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<Session>()),
          onSome: (cur) =>
            nowIso.pipe(
              Effect.map((endedAt): Session => ({ ...cur, endedAt })),
              Effect.tap(writeSession),
              Effect.tap(() => writePointer(Option.none())),
              Effect.map(Option.some)
            )
        })
      )
    )

    const get = (id: string) => readSession(id)

    const list = fs.readDirectory(paths.sessionsDir).pipe(
      mapPersist("list sessions dir"),
      Effect.flatMap((files) =>
        Effect.forEach(
          files.filter((f) => f.endsWith(".json")),
          (f) => readSession(f.slice(0, -".json".length)).pipe(Effect.option),
          { concurrency: "unbounded" }
        )
      ),
      Effect.map((opts) => opts.filter(Option.isSome).map((o) => o.value)),
      Effect.map((all) => [...all].sort((a, b) => b.startedAt.localeCompare(a.startedAt)))
    )

    const append = (entry: Omit<SessionEntry, "ts">) =>
      current.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (cur) =>
              nowIso.pipe(
                Effect.map((ts): Session => ({ ...cur, entries: [...cur.entries, { ...entry, ts }] })),
                Effect.flatMap(writeSession)
              )
          })
        )
      )

    return { start, end, current, get, list, append } as const
  })
}) {}
