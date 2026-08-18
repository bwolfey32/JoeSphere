# CLAUDE.md

Project instructions live in @AGENTS.md — one file, so Claude Code and other agents
read the same rules and they can't drift apart.

## Verify changes with

```bash
node --check <file>                       # syntax
node scripts/fetch-events.mjs             # hits live sources; inspect before trusting
python3 -m http.server 8000               # serve the site locally
```

There is no test suite yet. **Adding one is the first task** — see Known gaps in
@AGENTS.md.

## Ask before

- Restoring demo data to the default seed
- Loosening the URL validation in `parseVideo()` / `parseVideo0()` /
  `parseClipRange()`, or widening the `posts_clip_range` CHECK
- Removing or condensing the disclosure text or the *Unconfirmed* badge
- Adding any path that downloads, cuts or re-hosts a video file — a clip here
  is two integers on purpose (invariant #15)

These look like cleanup and are not. The reasoning is in @AGENTS.md.
