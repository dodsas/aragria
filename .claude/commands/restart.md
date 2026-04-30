---
description: Kill the running Aragria dev server and start a fresh one in the background.
allowed-tools: Bash
---

Restart the Aragria dev server. Steps:

1. Kill anything listening on the configured port (default 3000):
   `PORT="${PORT:-3000}"; lsof -ti:"$PORT" | xargs kill -9 2>/dev/null; sleep 0.1`
   - Silent if nothing is bound — that's fine.
   - Use `lsof` rather than `pkill -f node`, which would also kill unrelated node processes (other projects, language servers, etc.).
   - Post-kill sleep is short — the OS releases the port within a tick.
2. Start the server in the background, dev mode by default, going through `node` directly (skip the `npm run` wrapper — it adds ~300–500 ms of startup overhead):
   `DEV=1 node /Users/nam-yuseon/IdeaProjects/aragria/server/index.js` with `run_in_background: true`.
   - Dev mode (`DEV=1`) relaxes per-IP connection rate limit and switches client sid to `sessionStorage` so multiple tabs are independent players for testing.
   - To restart in production mode instead (only if explicitly asked), drop the `DEV=1` prefix.
3. Confirm boot by polling the background output instead of a fixed sleep — Node typically prints the listen line within 200–400 ms:
   `for i in $(seq 1 20); do grep -q "Aragria server listening" "<output_file>" 2>/dev/null && break; sleep 0.05; done && cat "<output_file>"`
   - Substitute `<output_file>` with the path the background-task tool returned.
   - Cap is 1 s (20 × 50 ms). If still not booted, surface the file contents so any error (EADDRINUSE, syntax error, etc.) is visible.
4. Report the result in one line including the `[DEV]` tag if present. Don't tail logs unless something failed.

Don't run any tests or lint as part of restart — this command is just kill + start.
