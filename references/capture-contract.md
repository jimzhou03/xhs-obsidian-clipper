# Xiaohongshu capture contract

## Required per-post fields

Every raw note must preserve:

- canonical URL and post ID;
- title, author, displayed publication time, and capture time;
- visible main body text;
- ordered post images downloaded locally when accessible;
- comments and replies loaded during this run;
- capture completeness and explicit warnings;
- a sanitized accessibility snapshot in `tmp/` for audit and repair.

## Search-result navigation

- Enter a post by clicking the uniquely matched search-result card. A bare `/explore/<id>` URL is not treated as a complete navigable URL.
- Confirm exactly one matching card before clicking. Bound the click to 10 seconds; on failure, write the result to the manifest instead of retrying indefinitely or blocking the batch.

## Completeness states

- `complete`: visible body was extracted, every discovered post image was saved, and comment loading stopped naturally before the configured cap.
- `partial`: body is missing, any discovered image failed to save, comment cap was hit, or comment structure could not be extracted.
- `failed`: no useful raw note was written.
- `blocked`: login, captcha, risk control, deleted/private content, or another access restriction prevented capture.

`complete` never means every comment that exists on Xiaohongshu. It means every comment that the browser successfully loaded under the configured expansion/scroll procedure was saved.

## Image handling

1. Discover likely post images, excluding avatars, icons, and logos.
2. Preserve carousel order when the DOM exposes it.
3. Download to `raw/assets/小红书/<post-id>/`.
4. Embed local Obsidian links in the raw note.
5. If download fails, retain the remote URL and failure reason in the manifest.
6. OCR image-only text in a separate, explicitly labelled pass; never present OCR as exact source text without review.

## Comment handling

1. Expand visible “更多回复/展开回复/查看更多评论” controls.
2. Scroll until the structured comment count is stable for the configured number of rounds or reaches `comment_limit`.
3. Save author display name, visible date, visible likes, text, and reply status when available.
4. Store the page’s displayed total label separately from the captured count.
5. Set `comment_limit_hit: true` when capped, and schedule the post for backfill if exhaustive loaded-comment capture was requested.

## Backfill

- Build `source_urls` from existing canonical URLs.
- Use a dedicated stable `batch_id` and `resume: true`.
- Skip `saved` and `partial` sources only when their raw note still exists; otherwise recapture them.
- Backfill newest/high-priority sources first, then older low-priority sources.
- Do not overwrite human-authored interpretation sections. Raw notes are source-layer files.
