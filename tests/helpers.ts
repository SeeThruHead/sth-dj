import { Effect, Layer } from "effect"
import { NodeContext } from "@effect/platform-node"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { Paths } from "../src/core/Paths.ts"

export const makeTempDir = Effect.tryPromise({
  try: () => fs.mkdtemp(path.join(os.tmpdir(), "sth-dj-test-")),
  catch: (cause) => new Error(`failed to mktemp: ${cause}`)
})

export const cleanupDir = (dir: string) =>
  Effect.tryPromise({
    try: () => fs.rm(dir, { recursive: true, force: true }),
    catch: (cause) => new Error(`failed to rm ${dir}: ${cause}`)
  })

/**
 * A Paths layer pointing into `root`. Use with `provide` to give Sessions/RoonClient
 * a sandboxed filesystem area for the duration of a test.
 */
export const TestPathsLayer = (root: string) =>
  Layer.succeed(Paths, {
    configDir: root,
    roonStateFile: path.join(root, "roon-state.json"),
    envFile: path.join(root, ".env"),
    sessionsDir: path.join(root, "sessions"),
    pointerFile: path.join(root, "current-session.json")
  } as Paths)

export const TestPlatformLayer = NodeContext.layer
