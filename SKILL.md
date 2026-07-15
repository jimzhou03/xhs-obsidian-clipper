---
name: xhs-obsidian-clipper
description: Capture Xiaohongshu posts into an Obsidian vault as auditable per-post source notes, including visible body text, locally saved post images, loaded comments, canonical URLs, completeness metadata, resumable manifests, and topic synthesis. Use when the user asks Codex to search, archive, backfill, analyze, or summarize 小红书/Xiaohongshu content into Obsidian, especially when using the bundled Browser or Chrome plugin.
---

# Xiaohongshu to Obsidian

## Core rules

- Use the browser explicitly chosen by the user. Use the bundled in-app Browser when the user names `浏览器`; use Chrome only when the user names Chrome or requires its extensions/session.
- Treat direct per-post capture as the default. Do not call a batch “fully captured” when only a title, excerpt, screenshot, or synthesis note exists.
- Keep source facts, AI analysis, and user-authored judgment separate according to the vault `AGENTS.md`.
- Save canonical post URLs without temporary access tokens.
- Never inspect cookies, local storage, passwords, profiles, or session files; never bypass login, captcha, risk control, paid, private, deleted, or restricted content.

## Batch policy

- Default to `max_items: 50`; accept up to 100 posts in one user task.
- Process internally in checkpoints of at most 20 posts. Write the manifest after every post so a crash can resume without repeating saved sources.
- Deduplicate by canonical post ID before opening details.
- For backfill, pass `source_urls` and a stable `batch_id`; do not search again unless sources are missing.

## Complete-capture workflow

1. Read [references/capture-contract.md](references/capture-contract.md) before a live capture or backfill.
2. Confirm the target vault and browser session. The user must already be signed in when the page requires authentication.
3. Create a config from `config.example.json`. Keep `capture_mode: direct` unless the user explicitly wants Web Clipper.
4. Initialize the selected bundled browser runtime and import `scripts/codex_chrome_xhs_clipper.mjs`. Pass the selected browser binding through `browser`.
5. Run `runXhsObsidianClipper({ configPath, browser })`.
6. Treat `tmp/xhs-obsidian-clipper/<batch_id>/chrome-manifest.json` as the source of truth. Inspect `saved`, `partial`, `failed`, and `blocked` separately.
7. Do not synthesize a post whose raw note is absent. Partial posts may be listed as a review queue but must not support strong conclusions.
8. Run `scripts/analyze_clippings.py` with the manifest to generate evidence and maps. Mark policy, tax, visa, school-rule, employment-law, salary, contract, and admission claims for official verification.

## Browser invocation

Use the browser plugin’s documented setup. After selecting a browser binding:

```js
const mod = await import("file:///ABSOLUTE/PATH/xhs-obsidian-clipper/scripts/codex_chrome_xhs_clipper.mjs");
await mod.runXhsObsidianClipper({
  browser: iab,
  configPath: "C:/ABSOLUTE/PATH/config.local.json"
});
```

For Chrome, pass `browser: chrome`. Do not switch surfaces when the user explicitly selected one.

## Analysis

```powershell
python -X utf8 scripts\analyze_clippings.py `
  --config config.local.json `
  --manifest tmp\xhs-obsidian-clipper\<batch_id>\chrome-manifest.json `
  --write-map `
  --update-log
```

## Failure handling

- `blocked`: stop and ask the user to sign in or clear the visible verification in the selected browser.
- `partial`: preserve the raw note and completeness metadata; schedule only the missing body, images, or comments for backfill.
- Image download failure: preserve the original image URL and record the failure; never claim local image preservation.
- Comment count mismatch: report “captured all comments loaded in this run,” not “all platform comments.” Hidden, deleted, folded, rate-limited, or inaccessible comments cannot be guaranteed.
- Image-only post without OCR: mark `body_extracted: false` or `image_text_ocr_required`; do not infer the image’s claims from its title.

## Output contract

Each successful direct-capture batch produces:

- `raw/archive/网络内容/小红书/posts/<post-id>-<title>.md`
- `raw/assets/小红书/<post-id>/` for successfully downloaded post images
- `tmp/xhs-obsidian-clipper/<batch_id>/snapshots/<post-id>.md`
- `tmp/xhs-obsidian-clipper/<batch_id>/chrome-manifest.json`
- after analysis: `evidence.json`, `map-preview.md`, and optional `wiki/maps`/`wiki/log.md` updates

Report the requested count, collected count, saved count, partial count, image saved/failed totals, loaded comment totals, blocked items, manifest path, and generated Obsidian paths.
