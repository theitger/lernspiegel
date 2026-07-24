# lernspiegel

**Learnweb, lokal gespiegelt.** Mirrors your [Uni Münster Learnweb](https://www.uni-muenster.de/LearnWeb/learnweb2/) (Moodle) courses into a local folder — so you, and any AI coding agent you use (Claude Code, Codex, …), can read course materials as plain files **without the agent ever touching your university credentials**.

```
█████████████████░░░░░░░ 143/199 · 294.3 MB/335.9 MB · Exercise Sheet 03.pdf
```

## Why

AI agents are great at "summarize this week's slides" or "solve exercise sheet 3 with me" — but handing your university password to an AI toolchain is a terrible idea. lernspiegel splits the problem:

```
Learnweb (university)
   ▲  token from macOS Keychain
   │
learnweb CLI  ──writes──►  ~/Learnweb/   ◄──reads── your AI agents
                            (plain files)             │
              sync_now (subprocess) ◄── MCP server ◄──┘
                                        (token-free)
```

- Your password is typed once, locally, into `learnweb login` — sent only to the university server, never stored.
- The resulting API token (the same mechanism the official Moodle app uses) lives in the **macOS Keychain**, never in files or env vars.
- The bundled **MCP server is deliberately token-free**: it only lists and searches the local mirror. Agents get course data; credentials stay out of reach by design.

## Requirements

- macOS (the token is stored via the system Keychain)
- Node.js ≥ 20
- A Learnweb account — or any Moodle instance with mobile web services enabled (see below)

## Install

Via Homebrew:

```sh
brew tap theitger/tap
brew install lernspiegel
```

This provides `learnweb` (the CLI) and `learnweb-mcp` (the token-free MCP server), and pulls in `node` automatically.

Or manually from this repo:

```sh
git clone https://github.com/theitger/lernspiegel
cd lernspiegel
npm install && npm run build && npm link   # provides `learnweb` and `learnweb-mcp`
```

Requirements:

```text
macos
node >= 20
```

## Quickstart

```sh
learnweb login            # username + password → token in Keychain
learnweb sync --dry-run   # see what would be downloaded (with total size)
learnweb sync             # mirror your current-semester courses to ~/Learnweb
```

Re-running `sync` is incremental: only new or changed files are downloaded. Interrupted downloads never leave half-written files (`.part` + atomic rename).

## Commands

| Command | Purpose |
| --- | --- |
| `learnweb login [--token <t>] [--mirror <dir>] [--url <moodle>]` | Obtain + store an API token (or reuse an existing one) |
| `learnweb courses [--json]` | List enrolled courses with current/old/excluded status |
| `learnweb sync [courses…] [--all] [--dry-run] [--max-size <mb>]` | Incremental mirror — current-semester courses by default, `--all` for everything (size cap 200 MB) |
| `learnweb exclude <courses…>` / `include <courses…>` | Permanently skip courses / always sync them |
| `learnweb status [--json]` | Mirror state (last sync, file count) |
| `learnweb logout` | Delete the token from the Keychain |

Courses can be addressed by id, shortname, or any unique name fragment: `learnweb sync statistik`. Ambiguous fragments error out with the candidates instead of guessing.

## How "current semester" is detected

Learnweb rarely maintains course end dates, so lernspiegel uses two signals that are actually reliable:

1. **Category path** — Learnweb files finished courses into "Archiv …" categories; anything archived is old.
2. **Start date** — semester courses are created shortly before term start (SoSe: April, WiSe: October). Standing courses (coordination, student councils, …) carry years-old start dates and are skipped by default.

`learnweb courses` shows the verdict per course; `include`/`exclude` override it permanently.

## AI agent integration

**Claude Code:**

```sh
claude mcp add --scope user learnweb -- node /path/to/lernspiegel/dist/mcp.js
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.learnweb]
command = "node"
args = ["/path/to/lernspiegel/dist/mcp.js"]
```

MCP tools: `list_courses`, `list_materials`, `search_materials`, `sync_status`, `sync_now`. All return absolute local paths — agents read the files with their normal file tools. `sync_now` refreshes the mirror by running the CLI as a subprocess (the CLI holds the credentials; the MCP server never does).

Agents that can run shell commands don't even need MCP — the mirror is just files.

## Other Moodle instances

Defaults target Uni Münster, but the whole stack is standard Moodle web services:

```sh
learnweb login --url https://moodle.example.edu
```

This works if the instance has mobile web services enabled (i.e. the official Moodle app works with it). The "Archiv" semester detection is Learnweb-specific; on other instances use explicit course selection or `--all`.

## Limitations & roadmap

- Mirrors files, folders and external links from course pages. Assignments, forums, announcements and deadlines are planned — the API client already supports extending it.
- Files deleted upstream are kept locally (no pruning — old slides don't vanish from under you).
- macOS-only for now (Keychain); a cross-platform secret store would lift that.

## Fair use

This uses the same API as the official Moodle app, for your own courses. Be a good citizen: downloads are throttled (3 concurrent), and there's no reason to sync more often than a few times a day. Not affiliated with Uni Münster.

## License

[MIT](LICENSE)
