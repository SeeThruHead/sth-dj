import { Effect, Schema } from "effect"
import { FileSystem } from "@effect/platform"
import { Paths } from "./Paths.ts"

/**
 * Service-agnostic file/JSON helpers built on @effect/platform/FileSystem.
 * Errors flow through as `PlatformError` from the platform; services should
 * map them to their own tagged errors at the boundary.
 */

export const ensureDir = (dir: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.makeDirectory(dir, { recursive: true })))

export const readFileText = (file: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readFileString(file)))

export const writeFileText = (file: string, content: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.writeFileString(file, content)))

export const removeFile = (file: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.remove(file, { force: true })))

export const fileExists = (file: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(file).pipe(Effect.orElseSucceed(() => false)))
  )

export const listDir = (dir: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readDirectory(dir)))

export const writeJson = (file: string, value: unknown) =>
  writeFileText(file, JSON.stringify(value, null, 2))

export const readJsonAs = <A, I>(file: string, schema: Schema.Schema<A, I>) =>
  readFileText(file).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) => new Error(`invalid JSON in ${file}: ${cause}`)
      })
    ),
    Effect.flatMap((parsed) => Schema.decodeUnknown(schema)(parsed))
  )

/**
 * Loads ~/.config/sth-dj/.env into process.env (only for keys not already set).
 * Side effect contained behind an Effect; no-op when file missing.
 */
export const loadEnvFile = Effect.gen(function* () {
  const paths = yield* Paths
  const exists = yield* fileExists(paths.envFile)
  if (!exists) return
  const txt = yield* readFileText(paths.envFile)
  yield* Effect.sync(() => {
    for (const raw of txt.split("\n")) {
      const line = raw.trim()
      if (!line || line.startsWith("#")) continue
      const eq = line.indexOf("=")
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "")
      if (key && process.env[key] === undefined) process.env[key] = val
    }
  })
})
