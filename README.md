# sth-dj

A command-line remote for [Roon](https://roon.app), built so an AI agent can DJ your library.

The CLI does the talking to Roon — search, queue, transport, browse. Something else (you, a shell script, an LLM) decides what to play. Every command is one shot: it connects, does the thing, prints a line, exits.

https://github.com/SeeThruHead/sth-dj/raw/main/docs/demo.mp4

Asking for a history of pop punk: the agent writes the history and queues the tracks in Roon as it goes.

```console
$ sth-dj play "Search and Destroy Stooges"
▶ Search and Destroy (2023 Remaster; Album Version)  →  K17

$ sth-dj now
Zone: K17 [playing]
  Search and Destroy
  The Stooges
  Raw Power
```

## Requirements

- **Node 22.6 or newer.** The CLI runs TypeScript directly via Node's type stripping, so there is no build step. `node --version` to check.
- **pnpm 11+** — `npm install -g pnpm`
- **A Roon Core** running on the same network, and the Roon app to approve the extension once.

Works on macOS, Linux, and Windows via WSL2. See [WSL2 networking](#wsl2-networking) below — it needs one setting changed.

## Install

```bash
git clone https://github.com/YOUR-USER/sth-dj.git
cd sth-dj
pnpm install
```

Put it on your `PATH`:

```bash
mkdir -p ~/.local/bin
ln -s "$PWD/bin/sth-dj.ts" ~/.local/bin/sth-dj
```

If `~/.local/bin` isn't already on your `PATH`, add it to your shell profile:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
```

## Configure

`sth-dj` reads `~/.config/sth-dj/config.json`. It won't run without it. Create it now:

```bash
mkdir -p ~/.config/sth-dj
cat > ~/.config/sth-dj/config.json <<'JSON'
{
  "publisher": "Your Name",
  "email": "you@example.com",
  "defaultZone": "Living Room"
}
JSON
```

| Key | Required | Purpose |
| --- | --- | --- |
| `publisher` | yes | Shown as the extension publisher in Roon → Settings → Extensions |
| `email` | yes | Contact address shown next to the extension in Roon |
| `defaultZone` | no | Zone used when you omit `--zone`. Falls back to whichever zone is playing. |

Roon requires a publisher name and contact address to register an extension and displays both in its UI. They identify *your* install, which is why they live in your config rather than in this repo.

`XDG_CONFIG_HOME` is honoured if set, so the config lands in `$XDG_CONFIG_HOME/sth-dj/` instead.

## Pair with Roon

First run advertises an extension named **STH DJ** on your network:

```bash
sth-dj zones
```

While that's running, open **Roon → Settings → Extensions** and click **Enable** next to *STH DJ*. You should see your zones listed:

```console
K17 [playing]
Kitchen [stopped]
```

The pairing token is saved to `~/.config/sth-dj/roon-state.json` and reused from then on. You only do this once.

## Usage

### Playing things

| Command | Effect |
| --- | --- |
| `sth-dj play "<query>"` | Search tracks, **replace** the queue, start playing |
| `sth-dj play` | Resume (no-op if already playing) |
| `sth-dj queue "<query>"` | Search tracks, **append** to the queue |
| `sth-dj play-next "<query>"` | Insert as the next track |
| `sth-dj play-album "<query>"` | Play a whole album |
| `sth-dj queue-album "<query>"` | Append a whole album |
| `sth-dj play-artist "<query>"` | Start an artist's discography |

Queries are matched by Roon's own search, so `"Beck Odelay"` or `"Murder Song"` both work. The first matching track wins — to pin a specific version, include more of the title.

### Transport

```bash
sth-dj pause
sth-dj next / previous / stop
sth-dj seek 90              # absolute, in seconds
sth-dj volume 45            # 0-100
sth-dj mute        [--off]
sth-dj shuffle     [--off]
sth-dj radio       [--off]  # Roon's auto-queue-extension
```

### Queue

```bash
sth-dj queue-mgr list        # queue with queue_item_ids
sth-dj queue-mgr clear       # skip past everything, then stop
sth-dj queue-mgr jump <id>   # play from that queue position
```

Roon has no true "clear queue" API. `clear` jumps to the end of the queue and stops, which leaves the queue effectively empty. Building a fresh set with `play` is the clean way to replace a queue outright.

### Browsing

```bash
sth-dj library artists   [--limit 50]
sth-dj library albums    [--limit 50]
sth-dj library tracks    [--limit 50]
sth-dj library composers [--limit 50]
sth-dj library tags      [--limit 50]
sth-dj playlists list
sth-dj playlists play "<name>"    # substring match
```

### Zone and output flags

`--zone <name|zone_id>` (or `-z`) works on every playback, transport, queue, library and playlist command. It's a case-insensitive substring match on the zone name, or an exact `zone_id`. Omit it and you get `defaultZone` from your config, falling back to whichever zone is currently playing.

`--json` is available on the commands that return data to read — `zones`, `now`, `queue-mgr list`, `library *`, `playlists list`, `session list`, `session show`. Action commands like `play` and `queue` print a single confirmation line instead.

Run `sth-dj --help`, or `sth-dj <command> --help`, for the authoritative list.

### Sessions

Session logging records what got played, for review later:

```bash
sth-dj session start "late-night drive"
# ... play/queue commands are logged ...
sth-dj session end

sth-dj session list
sth-dj session show [<id>]
```

Logs are plain JSON in `~/.config/sth-dj/sessions/`, one file per session. Each entry records the query you asked for and what Roon actually resolved it to.

## Using it with an AI agent

The CLI is the hands; the model is the taste. A workable system prompt is "you are a curator, use `sth-dj` to control playback, always pass `--json` when you need to read output". Two things make a real difference:

**Clear the queue before building a set.** With `radio` on, Roon continuously appends its own picks. If you append without clearing, your tracks sit *behind* Roon's, and the set plays in the wrong order.

**Handle empty search results.** A too-specific query returns nothing. Retry with just the artist, or pick a different track — don't loop on the same string.

## Troubleshooting

**`no config found at ...`** — you haven't created `config.json`. See [Configure](#configure). The error prints the exact file to create.

**`... is missing required keys`** — the file exists but `publisher` or `email` is absent or empty.

**`sth-dj zones` prints nothing / hangs** — Roon hasn't approved the extension yet. Open Roon → Settings → Extensions and enable *STH DJ*. If it isn't listed, the CLI can't see your Core (see below).

**Zones list is empty but pairing worked** — the Core is up but has no active zones. Play something in Roon first.

**`ZoneNotFound`** — the `--zone` name doesn't match. Run `sth-dj zones` for exact names; matching is a case-insensitive substring.

**`NoSearchResult`** — Roon found nothing. Simplify the query.

### WSL2 networking

Roon discovery uses UDP broadcast on the local network. WSL2's default NAT networking puts your Linux environment on a different virtual network than your Roon Core, so discovery finds nothing and the extension never appears in Roon.

Fix it by switching WSL to mirrored networking (requires WSL 2.0.0+ on Windows 11). In `%UserProfile%\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

Then `wsl --shutdown` from PowerShell and reopen your shell. Your Linux side now shares the Windows host's network interfaces and discovery works.

On Windows 10, or if mirrored mode isn't available, run `sth-dj` on the Windows host or another machine on the same LAN instead.

## Development

```bash
pnpm typecheck
pnpm test
```

The codebase is [Effect](https://effect.website)-based. `src/core/` holds the services — `RoonClient` wraps the callback-style Roon API, `Sessions` handles logging, `AppConfig` and `Paths` resolve configuration. `src/cli/` is the [@effect/cli](https://github.com/Effect-TS/effect/tree/main/packages/cli) command surface.

Notes for anyone touching `RoonClient`:

- Node 22+ ships a native `WebSocket` that `node-roon-api` can't use, so `bin/sth-dj.ts` deletes the global before importing anything, letting the library fall back to the `ws` package.
- Roon acts on `play_from_here` but never sends a response. Waiting on its callback stalls for 20–30 seconds until the websocket heartbeat gives up, so that one call resumes immediately.
- When the Core unpairs, the cached connection is discarded so the next command re-pairs, rather than reusing a dead socket.

## License

MIT
