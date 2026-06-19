---
name: xhs-obsidian-clipper
description: Automate Xiaohongshu-to-Obsidian research capture and synthesis. Use when the user asks Codex to search Xiaohongshu/小红书 from their logged-in Chrome account, clip posts with Obsidian Web Clipper, save Markdown notes into an Obsidian vault Clippings folder, then read the saved posts and summarize them into an Obsidian document or Codex response.
---

# Xiaohongshu Obsidian Clipper

## Core Workflow

1. Infer the search query from the user's request.
   - Prefer the user's original topic phrase as the primary query.
   - Remove only command words such as "抓取", "搜索", "小红书", "总结", "用这个 skill".
   - If the request contains several topics, use the most specific one; ask only when multiple unrelated topics would produce different batches.

2. Check preconditions before live clipping.
   - Chrome must have the Codex Chrome Extension connected.
   - The user must already be logged in to Xiaohongshu in Chrome.
   - Obsidian Desktop must have the target vault open.
   - Obsidian Web Clipper must save into the vault's `Clippings` folder.
   - Web Clipper should have a keyboard shortcut; default examples use `Alt+Shift+O`.

3. Configure a batch.
   - Default `max_items` to `20`; do not exceed 20 in this MVP.
   - Default `clip_dir` to `Clippings`.
   - Default `output_dir` to `wiki/maps`.
   - Use a stable `batch_id`, for example `xhs-YYYYMMDD-topic`.
   - If no vault path is specified, use the current workspace as the vault.

4. Run Chrome clipping through the bundled JS runner.
   - Read and follow the Chrome plugin skill instructions before controlling Chrome.
   - Initialize the Chrome browser runtime, then import `scripts/codex_chrome_xhs_clipper.mjs`.
   - Run `runXhsObsidianClipper({ configPath })`.
   - The runner opens Xiaohongshu search, collects `/explore/` post links, opens each post, triggers Web Clipper, and waits for new Markdown files in `Clippings`.
   - Treat `tmp/xhs-obsidian-clipper/<batch_id>/chrome-manifest.json` as the source of truth for clipped files.

5. Analyze clipped Markdown locally.
   - Run `scripts/analyze_clippings.py` with `python -X utf8`.
   - Pass `--manifest` when a Chrome run produced one.
   - Use `--write-map --update-log` when the user wants the result saved into Obsidian.
   - For a Codex-only response, read the generated `evidence.json` and summarize in the chat without writing the final map.

## Safety Rules

- Do not inspect Chrome cookies, localStorage, passwords, session stores, or browser profile files.
- Do not bypass login, captcha, risk-control, paid, private, or restricted content.
- Stop and ask the user to handle login/captcha if the runner reports `blocked`.
- If Web Clipper creates empty `Untitled*.md` files with blank `title/source` and no body, report `blank_or_unresolved_clipping_created` and ask the user to fix Web Clipper focus/template/shortcut settings before retrying.
- Do not transmit private vault files to external sites.
- Keep the run slow and bounded; do not scrape more than 20 posts per user request.
- Preserve source links in all Obsidian summaries.
- Mark policy, tax, visa, school-rule, or employment-law claims as needing official verification.

## Commands

Create a local config from `config.example.json`, then update `query`, `batch_id`, and shortcut settings.

Chrome run from the Codex Node REPL:

```js
const { setupBrowserRuntime } = await import("<你的 Codex Chrome 插件目录>/scripts/browser-client.mjs");
await setupBrowserRuntime({ globals: globalThis });
globalThis.browser = await agent.browsers.get("extension");

const mod = await import("file:///ABSOLUTE/PATH/TO/xhs-obsidian-clipper/scripts/codex_chrome_xhs_clipper.mjs");
await mod.runXhsObsidianClipper({
  configPath: "ABSOLUTE/PATH/TO/config.local.json"
});
```

Analyze a Chrome batch and write an Obsidian topic map:

```powershell
python -X utf8 scripts\analyze_clippings.py `
  --config config.local.json `
  --manifest tmp\xhs-obsidian-clipper\<batch_id>\chrome-manifest.json `
  --write-map `
  --update-log
```

Dry-run on existing `Clippings` without editing `wiki/maps` or `wiki/log.md`:

```powershell
python -X utf8 scripts\analyze_clippings.py `
  --config config.example.json `
  --query "GRE 备考方法" `
  --batch-id dry-run-xhs-gre `
  --dry-run
```

## Output Contract

For each successful batch, produce:

- `tmp/xhs-obsidian-clipper/<batch_id>/chrome-manifest.json`
- `tmp/xhs-obsidian-clipper/<batch_id>/evidence.json`
- `tmp/xhs-obsidian-clipper/<batch_id>/map-preview.md`
- optionally `wiki/maps/小红书-<关键词>-<YYYY-MM-DD>.md`
- optionally an appended record in `wiki/log.md`

When responding to the user, report:

- query used
- number of links collected
- number of posts saved
- generated Obsidian file path or preview path
- any blocked/failed items and the reason
