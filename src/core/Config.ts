import { Effect } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs/promises"

export const configDir = path.join(os.homedir(), ".config", "sth-dj")
export const roonStateFile = path.join(configDir, "roon-state.json")
export const envFile = path.join(configDir, ".env")

export const ensureConfigDir = Effect.tryPromise({
  try: () => fs.mkdir(configDir, { recursive: true }),
  catch: (cause) => new Error(`failed to create config dir ${configDir}: ${cause}`)
})

export const readJson = <T>(file: string): Effect.Effect<T | null, Error> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const txt = await fs.readFile(file, "utf8")
        return JSON.parse(txt) as T
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
        throw e
      }
    },
    catch: (cause) => new Error(`failed to read ${file}: ${cause}`)
  })

export const writeJson = (file: string, value: unknown): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: () => fs.writeFile(file, JSON.stringify(value, null, 2)),
    catch: (cause) => new Error(`failed to write ${file}: ${cause}`)
  })

export const readEnvFileInto = Effect.tryPromise({
  try: async () => {
    try {
      const txt = await fs.readFile(envFile, "utf8")
      for (const raw of txt.split("\n")) {
        const line = raw.trim()
        if (!line || line.startsWith("#")) continue
        const eq = line.indexOf("=")
        if (eq === -1) continue
        const key = line.slice(0, eq).trim()
        const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "")
        if (key && process.env[key] === undefined) process.env[key] = val
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
    }
  },
  catch: (cause) => new Error(`failed to read ${envFile}: ${cause}`)
})
