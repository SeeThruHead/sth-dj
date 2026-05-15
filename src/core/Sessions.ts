import { Context, Effect, Layer, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { configDir, ensureConfigDir } from "./Config.ts"

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

const sessionsDir = path.join(configDir, "sessions")
const pointerFile = path.join(configDir, "current-session.json")

const Pointer = Schema.Struct({ id: Schema.String })

const ensureSessionsDir = Effect.tryPromise({
  try: () => fs.mkdir(sessionsDir, { recursive: true }),
  catch: (cause) => new Error(`failed to create sessions dir: ${cause}`)
})

const sessionPath = (id: string) => path.join(sessionsDir, `${id}.json`)

const readSessionFile = (id: string) =>
  Effect.tryPromise({
    try: () => fs.readFile(sessionPath(id), "utf8"),
    catch: (cause) => new Error(`failed to read session ${id}: ${cause}`)
  }).pipe(
    Effect.flatMap((txt) =>
      Schema.decodeUnknown(Session)(JSON.parse(txt)).pipe(
        Effect.mapError((e) => new Error(`invalid session ${id}: ${e}`))
      )
    )
  )

const writeSessionFile = (s: Session) =>
  Effect.tryPromise({
    try: () => fs.writeFile(sessionPath(s.id), JSON.stringify(s, null, 2)),
    catch: (cause) => new Error(`failed to write session ${s.id}: ${cause}`)
  })

const readPointer: Effect.Effect<string | null, Error> = Effect.tryPromise({
  try: async () => {
    try {
      return await fs.readFile(pointerFile, "utf8")
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
      throw e
    }
  },
  catch: (cause) => new Error(`failed to read current-session pointer: ${cause}`)
}).pipe(
  Effect.flatMap((txt) =>
    txt === null
      ? Effect.succeed(null)
      : Schema.decodeUnknown(Pointer)(JSON.parse(txt)).pipe(
          Effect.map((p) => p.id),
          Effect.mapError((e) => new Error(`invalid pointer file: ${e}`))
        )
  )
)

const writePointer = (id: string | null) =>
  Effect.tryPromise({
    try: () =>
      id === null
        ? fs.rm(pointerFile, { force: true })
        : fs.writeFile(pointerFile, JSON.stringify({ id }, null, 2)),
    catch: (cause) => new Error(`failed to update pointer: ${cause}`)
  })

const newId = () => {
  const d = new Date()
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export class Sessions extends Context.Tag("sth-dj/Sessions")<
  Sessions,
  {
    readonly start: (name: string) => Effect.Effect<Session, Error>
    readonly end: Effect.Effect<Session | null, Error>
    readonly current: Effect.Effect<Session | null, Error>
    readonly list: Effect.Effect<Session[], Error>
    readonly get: (id: string) => Effect.Effect<Session, Error>
    readonly append: (entry: Omit<SessionEntry, "ts">) => Effect.Effect<void, Error>
  }
>() {}

const make = Effect.gen(function* () {
  yield* ensureConfigDir
  yield* ensureSessionsDir

  const start = (name: string) =>
    Effect.gen(function* () {
      const id = newId()
      const session: Session = {
        id,
        name,
        startedAt: new Date().toISOString(),
        entries: []
      }
      yield* writeSessionFile(session)
      yield* writePointer(id)
      return session
    })

  const current = readPointer.pipe(
    Effect.flatMap((id) => (id === null ? Effect.succeed(null) : readSessionFile(id)))
  )

  const end = Effect.gen(function* () {
    const cur = yield* current
    if (cur === null) return null
    const ended: Session = { ...cur, endedAt: new Date().toISOString() }
    yield* writeSessionFile(ended)
    yield* writePointer(null)
    return ended
  })

  const list = Effect.gen(function* () {
    const files = yield* Effect.tryPromise({
      try: () => fs.readdir(sessionsDir),
      catch: (cause) => new Error(`failed to list sessions dir: ${cause}`)
    })
    const sessions: Session[] = []
    for (const f of files) {
      if (!f.endsWith(".json")) continue
      const id = f.slice(0, -".json".length)
      const s = yield* readSessionFile(id).pipe(Effect.either)
      if (s._tag === "Right") sessions.push(s.right)
    }
    return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  })

  const get = (id: string) => readSessionFile(id)

  const append = (entry: Omit<SessionEntry, "ts">) =>
    Effect.gen(function* () {
      const cur = yield* current
      if (cur === null) return
      const next: Session = {
        ...cur,
        entries: [...cur.entries, { ...entry, ts: new Date().toISOString() }]
      }
      yield* writeSessionFile(next)
    })

  return Sessions.of({ start, end, current, list, get, append })
})

export const SessionsLive = Layer.effect(Sessions, make)
