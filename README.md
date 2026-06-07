# nd

> Minimal CDP-based Node.js debugger CLI — works with tsx, esbuild, and any source-mapped Node app.

`nd` connects directly to Node's V8 inspector via the Chrome DevTools Protocol (CDP). No DAP adapter layer, no js-debug, no source map gymnastics in middleware. Just set a breakpoint on your `.ts` file, hit continue, and read locals.

Built because DAP-based tools (dap CLI, js-debug) don't reliably bind breakpoints when running `.ts` files through tsx — the source map handshake breaks. `nd` skips DAP entirely and decodes inline source maps itself.

## Why nd

| | dap CLI | nd |
|---|---|---|
| Protocol layers | DAP → js-debug → CDP → Node | CDP → Node |
| TypeScript via tsx | breakpoints often fail to bind | works |
| Single-language scope | multi-language (Python, Go, etc) | Node only |
| State persistence | daemon + Unix socket | daemon + Unix socket |
| Lines of code | ~10k Go | ~1k TS |

## Install

```bash
npm install -g nd
```

Or run from a clone:

```bash
git clone https://github.com/hon2be/nd
cd nd
npm install
./bin/nd.mjs run /path/to/your/script.ts
```

## Usage

```bash
# Launch a script under the debugger. Program pauses at line 1.
nd run ./server.ts --session myapp

# Set a breakpoint on a .ts file (line number in original source).
nd break src/api/handler.ts:42 --session myapp

# Resume; blocks until next breakpoint or program exits.
# Returns the paused location and call stack.
nd continue --session myapp

# Evaluate an expression in the current frame.
nd eval "user.profile.name" --session myapp

# End the session and kill the child process.
nd stop --session myapp
```

### Inspect what CDP sees

```bash
# List scripts CDP knows about (filter by substring).
nd scripts handler --session myapp

# Show a script's transpiled source (useful for debugging source map issues).
nd source <scriptId> --session myapp

# Show daemon state (pid, paused location, script path).
nd ping --session myapp
```

### Multiple sessions

Use `--session <name>` to run several debuggers concurrently. Each gets its own Unix socket at `~/.nd/<name>.sock`. Default session name is `default`.

## How it works

```
[nd CLI commands]                    [Node + your script]
       │                                      ▲
       │ ① Unix socket (~/.nd/<name>.sock)    │ ③ WebSocket
       │    JSON request/response             │    CDP (Chrome DevTools Protocol)
       ▼                                      │
[nd daemon (background process)] ─────────────┘
       ② holds CDP WS + tracks state (current pause, breakpoints, source maps)
```

The daemon:
1. Spawns `node --inspect-brk --import tsx <script>` as a child.
2. Reads child stderr for `Debugger listening on ws://…` and connects.
3. Enables `Debugger` and `Runtime` domains.
4. Captures `Debugger.scriptParsed` events; for each script with an inline source map, parses it.
5. Translates user-supplied breakpoints from `.ts:line` to `(scriptId, transpiledLine, column)` via the source map.
6. Reports paused locations back in the original `.ts` coordinates.

## What v0 supports

- `nd run` — launch a script, attach debugger
- `nd break <file>:<line>` — set a breakpoint (source-map aware)
- `nd continue` — resume until next breakpoint or exit
- `nd eval` — evaluate expression in current frame
- `nd ping` / `nd scripts` / `nd source` — introspection
- `nd stop` — end session

## What v0 does not yet support

- `nd step over/in/out`
- `nd locals` (auto-dump scope variables)
- Conditional breakpoints
- Multi-target launch
- Attach to a running Node process
- Anything other than Node (no Python, no Go, no browser)

## License

MIT
