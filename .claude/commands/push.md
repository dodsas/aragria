---
description: One-shot ship workflow — review diff, write a Korean commit message, then git add . / commit / push.
allowed-tools: Bash
---

Ship the current local changes in one go. The user has already authorized the push by invoking this command — don't ask for further confirmation.

Run steps 1–3 in parallel as a single message of three Bash calls:

1. `git status` (no `-uall` flag)
2. `git diff HEAD` (staged + unstaged combined)
3. `git log -n 5 --oneline` (sample the repo's existing commit style)

Then proceed sequentially:

4. **Sanity check.** If the diff includes anything that looks like a secret (`.env`, `*.key`, `credentials*`, hardcoded API tokens) or a large binary that doesn't belong, STOP. Surface what you saw and do not commit.
5. **Write the commit message.** Korean, 1–2 sentences, summarizing what changed and *why* — not a file list. Match the repo's terse tone (recent commits sampled in step 3 are the reference). Don't invent features that aren't in the diff.
6. **Stage and commit:**
   - `git add .` (the user explicitly requested `.`)
   - Commit with a HEREDOC so formatting survives:
     ```
     git commit -m "$(cat <<'EOF'
     <your message>

     Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
     EOF
     )"
     ```
   - If the commit fails (pre-commit hook), fix the underlying issue and create a NEW commit. Never `--amend`, never `--no-verify`.
7. **Push:**
   - `git push`. If the branch has no upstream, run `git push -u origin HEAD`.
   - **Refuse if** the current branch is `main` or `master` — warn the user and abort instead. They should ship to that via PR.
8. **Report:** one line — the commit subject and the push result (e.g. branch and remote ref). Don't paste the full git output unless something failed.

Don't run tests, lint, or `npm run` anything as part of this command — pre-commit hooks are the gate.
