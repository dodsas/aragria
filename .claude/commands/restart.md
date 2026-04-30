---
description: Kill the running Aragria dev server and start a fresh one in the background.
allowed-tools: Bash
---

Restart the Aragria dev server. Steps:

1. Kill anything listening on the configured port (default 3000):
   `PORT="${PORT:-3000}"; lsof -ti:"$PORT" | xargs -r kill -9 2>/dev/null; sleep 0.3`
   - Silent if nothing is bound — that's fine.
   - Use `lsof` rather than `pkill -f node`, which would also kill unrelated node processes (other projects, language servers, etc.).
2. Start the server in the background from the project root:
   `cd /Users/dodsas/IdeaProjects/aragria && npm start` with `run_in_background: true`.
3. Wait briefly (~1.5s) and confirm it booted by reading the background output. The success line is `Aragria server listening on http://localhost:<PORT>`. If the output shows an error (e.g. EADDRINUSE, syntax error), surface it.
4. Report the result in one line. Don't tail logs unless something failed.

Don't run any tests or lint as part of restart — this command is just kill + start.
