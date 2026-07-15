import fs from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  query: "德国 HiWi 申请",
  max_items: 50,
  hard_max_items: 100,
  checkpoint_size: 20,
  batch_id: null,
  vault_dir: null,
  clip_dir: "Clippings",
  raw_dir: "raw/archive/网络内容/小红书/posts",
  asset_dir: "raw/assets/小红书",
  evidence_dir: "tmp/xhs-obsidian-clipper",
  capture_mode: "direct",
  source_urls: [],
  resume: true,
  chrome: {
    search_url:
      "https://www.xiaohongshu.com/search_result?keyword={query}&source=web_explore_feed",
    clipper_shortcut: ["Alt", "Shift", "C"],
    save_keys: ["Enter"],
    open_delay_ms: 3000,
    after_save_delay_ms: 1200,
    between_posts_ms: 4500,
    navigation_timeout_ms: 45000,
    clip_timeout_ms: 60000,
    scroll_pause_ms: 1500,
    max_scrolls: 18,
    comment_limit: 100,
    max_comment_scrolls: 30,
    comment_stable_rounds: 3,
    finalize: true,
  },
};

function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(base[key], value);
    } else if (value !== undefined && value !== null) {
      result[key] = value;
    }
  }
  return result;
}

function cwdFallback() {
  return globalThis.nodeRepl?.cwd || "C:/Users/lovane/Desktop/workplace";
}

function resolveFrom(base, value) {
  if (!value) return base;
  return path.isAbsolute(value) ? value : path.join(base, value);
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function batchId() {
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `xhs-${stamp}`;
}

async function readConfig(configPath, inlineConfig = {}) {
  let fileConfig = {};
  if (configPath) {
    const raw = await fs.readFile(configPath, "utf8");
    fileConfig = JSON.parse(raw);
  }
  const config = deepMerge(deepMerge(DEFAULTS, fileConfig), inlineConfig);
  if (!config.batch_id) config.batch_id = batchId();
  if (!config.vault_dir) config.vault_dir = cwdFallback();
  if (!Number.isInteger(config.max_items) || config.max_items < 1) {
    throw new Error("max_items must be a positive integer.");
  }
  if (config.max_items > config.hard_max_items || config.hard_max_items > 100) {
    throw new Error("max_items and hard_max_items must be <= 100.");
  }
  if (!Number.isInteger(config.checkpoint_size) || config.checkpoint_size < 1 || config.checkpoint_size > 20) {
    throw new Error("checkpoint_size must be between 1 and 20.");
  }
  if (!['direct', 'web_clipper'].includes(config.capture_mode)) {
    throw new Error("capture_mode must be direct or web_clipper.");
  }
  config.vault_dir = path.isAbsolute(config.vault_dir)
    ? config.vault_dir
    : path.join(cwdFallback(), config.vault_dir);
  config.clip_dir = resolveFrom(config.vault_dir, config.clip_dir);
  config.raw_dir = resolveFrom(config.vault_dir, config.raw_dir);
  config.asset_dir = resolveFrom(config.vault_dir, config.asset_dir);
  config.evidence_dir = resolveFrom(config.vault_dir, config.evidence_dir);
  return config;
}

async function listMarkdownFiles(dir) {
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const absolute = path.join(dir, entry.name);
    const stat = await fs.stat(absolute);
    files.push({ absolute, name: entry.name, mtimeMs: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

function relativeToVault(config, absolutePath) {
  return path.relative(config.vault_dir, absolutePath).replace(/\\/g, "/");
}

async function waitForNewMarkdown(config, beforeFiles, startedAtMs) {
  const before = new Set(beforeFiles.map((file) => file.absolute));
  const deadline = Date.now() + config.chrome.clip_timeout_ms;
  while (Date.now() < deadline) {
    const after = await listMarkdownFiles(config.clip_dir);
    const created = after.filter(
      (file) => !before.has(file.absolute) && file.mtimeMs >= startedAtMs - 1000
    );
    if (created.length) return created;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return [];
}

async function openSearch(tab, config) {
  const url = config.chrome.search_url.replace(
    "{query}",
    encodeURIComponent(config.query)
  );
  await tab.goto(url);
  await tab.playwright.waitForLoadState({
    state: "domcontentloaded",
    timeoutMs: config.chrome.navigation_timeout_ms,
  });
  await tab.playwright.waitForTimeout(1500);

  let state = await searchState(tab);
  if (!searchStateMatches(state, config.query)) {
    await submitSearchFromCurrentPage(tab, config.query);
    await tab.playwright.waitForTimeout(3000);
    state = await searchState(tab);
  }

  return {
    requested_url: url,
    final_url: await tab.url(),
    state,
    confirmed: searchStateMatches(state, config.query),
  };
}

async function searchState(tab) {
  return await tab.playwright.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input"))
      .map((input) => input.value || input.getAttribute("placeholder") || "")
      .filter(Boolean)
      .slice(0, 8);
    return {
      url: location.href,
      title: document.title || "",
      inputs,
    };
  });
}

function searchStateMatches(state, query) {
  const decodedUrl = decodeURIComponent(state?.url || "");
  const inputs = state?.inputs || [];
  return (
    decodedUrl.includes(query) ||
    inputs.some((value) => String(value).includes(query))
  );
}

async function submitSearchFromCurrentPage(tab, query) {
  const textbox = tab.playwright.locator('input[type="text"]');
  const count = await textbox.count();
  if (!count) return false;
  const target = count === 1 ? textbox : textbox.nth(0);
  await target.fill(query, { timeoutMs: 8000 });
  await target.press("Enter", { timeoutMs: 8000 });
  return true;
}

async function pageBlockerState(tab) {
  return await tab.playwright.evaluate(() => {
    const text = (document.body?.innerText || "").slice(0, 3000);
    const title = document.title || "";
    const url = location.href;
    const blocker =
      /验证码|安全验证|登录后|请登录|访问异常|环境异常|滑块/.test(text) ||
      /login|captcha|verify/.test(url);
    return { blocker, title, url, text };
  });
}

async function collectLinks(tab, config) {
  const links = [];
  const seen = new Set();

  for (let scrollIndex = 0; scrollIndex <= config.chrome.max_scrolls; scrollIndex++) {
    const pageLinks = await tab.playwright.evaluate(() => {
      return Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => {
          try {
            return new URL(anchor.getAttribute("href"), location.href).href;
          } catch {
            return "";
          }
        })
        .filter((href) => /xiaohongshu\.com\/explore\//.test(href));
    });

    for (const href of pageLinks) {
      const key = normalizeUrl(href);
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(href);
      if (links.length >= config.max_items) return links;
    }

    await tab.cua.scroll({ x: 700, y: 700, scrollY: 900, scrollX: 0 });
    await tab.playwright.waitForTimeout(config.chrome.scroll_pause_ms);
  }

  return links;
}

async function openPostFromSearchCard(tab, config, url) {
  const postId = postIdFromUrl(url);
  const selector = `a[href*="/explore/${postId}"]`;
  for (let scrollIndex = 0; scrollIndex <= config.chrome.max_scrolls; scrollIndex++) {
    const card = tab.playwright.locator(selector);
    const cardCount = await card.count();
    if (cardCount === 1) {
      await card.click({
        force: true,
        timeoutMs: Math.min(config.chrome.navigation_timeout_ms, 10000),
      });
      await tab.playwright.waitForTimeout(config.chrome.scroll_pause_ms);
      const state = await tab.playwright.evaluate(() => ({
        url: location.href,
        title: document.title,
      }));
      return state;
    }
    if (cardCount > 1) throw new Error(`search_card_ambiguous:${postId}:${cardCount}`);
    await tab.cua.scroll({ x: 700, y: 700, scrollY: 900, scrollX: 0 });
    await tab.playwright.waitForTimeout(config.chrome.scroll_pause_ms);
  }
  throw new Error(`search_card_not_found:${postId}`);
}

async function triggerClipper(tab, config) {
  const before = await listMarkdownFiles(config.clip_dir);
  const startedAtMs = Date.now();

  await tab.cua.keypress({ keys: config.chrome.clipper_shortcut });
  await tab.playwright.waitForTimeout(config.chrome.open_delay_ms);

  if (Array.isArray(config.chrome.save_keys) && config.chrome.save_keys.length) {
    await tab.cua.keypress({ keys: config.chrome.save_keys });
  }

  await tab.playwright.waitForTimeout(config.chrome.after_save_delay_ms);
  const created = await waitForNewMarkdown(config, before, startedAtMs);
  const valid = [];
  const invalid = [];
  for (const file of created) {
    if (await clippingLooksUseful(file.absolute)) {
      valid.push(relativeToVault(config, file.absolute));
    } else {
      invalid.push(relativeToVault(config, file.absolute));
    }
  }
  return { valid, invalid };
}

async function clippingLooksUseful(absolutePath) {
  let raw = "";
  try {
    raw = await fs.readFile(absolutePath, "utf8");
  } catch {
    return false;
  }
  const body = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
  const hasResolvedTitle = /^title:\s*["']?\S.+$/m.test(raw);
  const hasResolvedSource = /^source:\s*["']?https?:\/\//m.test(raw);
  const hasUsefulBody = body.length >= 80;
  return hasUsefulBody && (hasResolvedTitle || hasResolvedSource);
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function safeFilename(value, fallback = "xhs-post") {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function postIdFromUrl(url) {
  return String(url).match(/\/(?:explore|search_result)\/([0-9a-f]{16,})/i)?.[1] || "unknown";
}

function canonicalPostUrl(url) {
  const id = postIdFromUrl(url);
  return id === "unknown" ? normalizeUrl(url) : `https://www.xiaohongshu.com/explore/${id}`;
}

function sanitizeSnapshot(text) {
  return String(text || "")
    .replace(/([?&](?:xsec_token|xsec_source|source)=)[^&\s)]+/g, "$1<redacted>")
    .replace(/https:\/\/www\.xiaohongshu\.com\/(?:search_result|explore)\/([0-9a-f]{16,})[^\s)]*/gi,
      "https://www.xiaohongshu.com/explore/$1");
}

async function loadComments(tab, config) {
  let previous = -1;
  let stable = 0;
  let rounds = 0;
  let reachedLimit = false;
  for (; rounds < config.chrome.max_comment_scrolls; rounds++) {
    const state = await tab.playwright.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const expandPattern = /展开.*回复|查看.*回复|更多回复|查看更多评论|展开更多/;
      let clicked = 0;
      for (const element of document.querySelectorAll("button, [role=button], span, div")) {
        const text = (element.textContent || "").trim();
        if (text.length <= 40 && expandPattern.test(text) && visible(element)) {
          element.click();
          clicked += 1;
        }
      }
      const comments = Array.from(document.querySelectorAll(
        '[class*="comment-item"], [class*="commentItem"], [data-testid*="comment"]'
      )).filter(visible);
      const last = comments.at(-1);
      if (last) last.scrollIntoView({ block: "end" });
      else window.scrollBy(0, Math.max(700, window.innerHeight * 0.8));
      return { count: comments.length, clicked };
    });
    if (state.count >= config.chrome.comment_limit) {
      reachedLimit = true;
      break;
    }
    if (state.count === previous && state.clicked === 0) stable += 1;
    else stable = 0;
    previous = state.count;
    if (stable >= config.chrome.comment_stable_rounds) break;
    await tab.playwright.waitForTimeout(config.chrome.scroll_pause_ms);
  }
  return { rounds: rounds + 1, reached_limit: reachedLimit };
}

async function extractPost(tab, config) {
  const commentLoad = await loadComments(tab, config);
  const data = await tab.playwright.evaluate(() => {
    const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
    const firstText = (selectors) => {
      for (const selector of selectors) {
        const value = text(document.querySelector(selector));
        if (value) return value;
      }
      return "";
    };
    const meta = (selector) => document.querySelector(selector)?.getAttribute("content")?.trim() || "";
    const title = firstText([
      '#detail-title', '.note-content .title', '[class*="note-content"] [class*="title"]',
      '[class*="noteContent"] [class*="title"]', '.title'
    ]) || meta('meta[property="og:title"]') || document.title;
    const body = firstText([
      '#detail-desc', '.note-content .desc', '[class*="note-content"] [class*="desc"]',
      '[class*="noteContent"] [class*="desc"]', '[class*="note-text"]'
    ]) || meta('meta[name="description"]') || meta('meta[property="og:description"]');
    const author = firstText([
      '.author-container .username', '[class*="author"] [class*="name"]',
      '[class*="user"] [class*="name"]', 'a[href*="/user/profile/"]'
    ]);
    const published = firstText([
      '[class*="date"]', '[class*="time"]', '.bottom-container .date'
    ]);
    const tagLinks = Array.from(document.querySelectorAll('a[href*="type=54"]'))
      .map((node) => text(node)).filter(Boolean);
    const imageCandidates = Array.from(document.images).filter((img) => {
      const src = img.currentSrc || img.src || "";
      const cls = `${img.className || ""} ${img.parentElement?.className || ""}`;
      return /xhscdn|xiaohongshu/.test(src) && !/avatar|icon|logo/i.test(src + cls) &&
        (img.naturalWidth >= 400 || img.width >= 400) && (img.naturalHeight >= 250 || img.height >= 250);
    });
    const images = [...new Set(imageCandidates.map((img) => img.currentSrc || img.src).filter(Boolean))];
    const commentNodes = Array.from(document.querySelectorAll(
      '[class*="comment-item"], [class*="commentItem"], [data-testid*="comment"]'
    ));
    const comments = [];
    const seen = new Set();
    for (const node of commentNodes) {
      const contentNode = node.querySelector('[class*="content"], [class*="text"], .note-text');
      const raw = text(contentNode) || text(node);
      if (!raw || raw.length < 2 || raw.length > 1800 || seen.has(raw)) continue;
      seen.add(raw);
      comments.push({
        author: text(node.querySelector('a[href*="/user/profile/"], [class*="author"], [class*="name"]')),
        text: raw,
        date: text(node.querySelector('[class*="date"], [class*="time"]')),
        likes: text(node.querySelector('[class*="like"]')),
        is_reply: /reply|sub-comment|subComment/i.test(String(node.className || "")),
      });
    }
    const pageText = text(document.body);
    const totalLabel = pageText.match(/共\s*\d+\s*条评论/)?.[0] || "";
    return { title, body, author, published, tags: [...new Set(tagLinks)], images, comments, total_label: totalLabel };
  });
  data.comments = data.comments.slice(0, config.chrome.comment_limit);
  data.comment_load = commentLoad;
  data.page_url = await tab.url();
  return data;
}

function extensionFromType(contentType, url) {
  if (/png/i.test(contentType)) return ".png";
  if (/webp/i.test(contentType)) return ".webp";
  if (/gif/i.test(contentType)) return ".gif";
  if (/jpe?g/i.test(contentType)) return ".jpg";
  return String(url).match(/\.(png|webp|gif|jpe?g)(?:\?|$)/i)?.[0].toLowerCase() || ".jpg";
}

async function saveImages(config, postId, imageUrls) {
  const dir = path.join(config.asset_dir, postId);
  await fs.mkdir(dir, { recursive: true });
  const saved = [];
  const failed = [];
  for (let index = 0; index < imageUrls.length; index++) {
    const url = imageUrls[index];
    try {
      const response = await fetch(url, { headers: { Referer: "https://www.xiaohongshu.com/" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const ext = extensionFromType(response.headers.get("content-type") || "", url);
      const absolute = path.join(dir, `${String(index + 1).padStart(2, "0")}${ext}`);
      await fs.writeFile(absolute, bytes);
      saved.push({ url, file: relativeToVault(config, absolute), bytes: bytes.length });
    } catch (error) {
      failed.push({ url, reason: error?.message || String(error) });
    }
  }
  return { saved, failed };
}

function renderRawPost(config, sourceUrl, post, images, snapshotFile) {
  const postId = postIdFromUrl(sourceUrl);
  const commentLimitHit = Boolean(
    post.comment_load?.reached_limit || post.comments.length >= config.chrome.comment_limit
  );
  const captureStatus = post.body && !images.failed.length && !commentLimitHit
    ? "complete"
    : "partial";
  const lines = [
    "---",
    `title: ${yamlString(post.title || postId)}`,
    "type: web-note",
    "schema_version: 2",
    "status: inbox",
    "platform: 小红书",
    `source: ${yamlString(canonicalPostUrl(sourceUrl))}`,
    `source_id: ${yamlString(postId)}`,
    `author: ${yamlString(post.author)}`,
    `published: ${yamlString(post.published)}`,
    `captured: ${new Date().toISOString()}`,
    `capture_status: ${captureStatus}`,
    `body_extracted: ${Boolean(post.body)}`,
    `image_discovered_count: ${post.images.length}`,
    `image_saved_count: ${images.saved.length}`,
    `comment_total_label: ${yamlString(post.total_label)}`,
    `comment_captured_count: ${post.comments.length}`,
    `comment_limit_hit: ${commentLimitHit}`,
    `snapshot_file: ${yamlString(snapshotFile || "")}`,
    "review_required: true",
    "tags:",
    "  - 小红书",
    "  - 原始抓取",
    "---",
    "",
    `# ${post.title || postId}`,
    "",
    "## 来源事实：正文",
    "",
    post.body || "> 未取得可确认的正文文本，需要人工复核页面或图片。",
    "",
    "## 来源图片",
    "",
  ];
  if (images.saved.length) {
    for (const image of images.saved) lines.push(`![[${image.file}]]`);
  } else if (post.images.length) {
    lines.push("> 图片发现但本地下载失败，保留原始链接供人工复核：");
    for (const url of post.images) lines.push(`- ${url}`);
  } else {
    lines.push("> 页面未发现符合条件的正文图片。若原帖是图片型笔记，需要人工复核。 ");
  }
  lines.push("", "## 评论区（本次已加载）", "");
  lines.push(`> 页面标记：${post.total_label || "未显示总数"}；本次保存 ${post.comments.length} 条。受懒加载、折叠回复、删除和风控影响，不承诺等于平台全部评论。`);
  if (post.comments.length) {
    for (const comment of post.comments) {
      const prefix = comment.is_reply ? "  -" : "-";
      const meta = [comment.author, comment.date, comment.likes && `赞 ${comment.likes}`].filter(Boolean).join(" · ");
      lines.push(`${prefix} ${meta ? `**${meta}**：` : ""}${comment.text}`);
    }
  } else {
    lines.push("- 本次未取得结构化评论。");
  }
  lines.push("", "## 抓取完整性", "", `- 正文：${post.body ? "已提取" : "缺失"}`,
    `- 图片：发现 ${post.images.length}，本地保存 ${images.saved.length}，失败 ${images.failed.length}`,
    `- 评论：保存 ${post.comments.length}；滚动/展开 ${post.comment_load?.rounds || 0} 轮`,
    `- 原始页面快照：${snapshotFile ? `[[${snapshotFile.replace(/\.md$/, "")}]]` : "未保存"}`,
    "- 本页是原始资料层，不包含 AI 代写的用户观点。",
    "");
  return lines.join("\n");
}

async function directCapture(tab, config, url) {
  const post = await extractPost(tab, config);
  const postId = postIdFromUrl(url);
  const snapshot = sanitizeSnapshot(await tab.playwright.domSnapshot());
  const snapshotDir = path.join(config.evidence_dir, config.batch_id, "snapshots");
  await fs.mkdir(snapshotDir, { recursive: true });
  const snapshotAbsolute = path.join(snapshotDir, `${postId}.md`);
  await fs.writeFile(snapshotAbsolute, snapshot, "utf8");
  const images = await saveImages(config, postId, post.images);
  await fs.mkdir(config.raw_dir, { recursive: true });
  const filename = `${postId}-${safeFilename(post.title, postId)}.md`;
  const absolute = path.join(config.raw_dir, filename);
  const snapshotFile = relativeToVault(config, snapshotAbsolute);
  await fs.writeFile(absolute, renderRawPost(config, url, post, images, snapshotFile), "utf8");
  const commentLimitHit = Boolean(
    post.comment_load?.reached_limit || post.comments.length >= config.chrome.comment_limit
  );
  return {
    file: relativeToVault(config, absolute),
    post,
    image_saved_count: images.saved.length,
    image_failed_count: images.failed.length,
    image_failures: images.failed,
    snapshot_file: snapshotFile,
    capture_status: post.body && !images.failed.length && !commentLimitHit ? "complete" : "partial",
  };
}

async function clipOne(tab, config, url, index, options = {}) {
  const startedAt = new Date().toISOString();
  const result = {
    index,
    url,
    normalized_url: normalizeUrl(url),
    started_at: startedAt,
    status: "pending",
    saved_files: [],
    reason: null,
  };

  try {
    if (options.openFromSearchCard) {
      result.opened_from_search_card = await openPostFromSearchCard(tab, config, url);
    } else {
      await tab.goto(url);
      await tab.playwright.waitForLoadState({
        state: "domcontentloaded",
        timeoutMs: config.chrome.navigation_timeout_ms,
      });
    }

    const blocker = await pageBlockerState(tab);
    if (blocker.blocker) {
      result.status = "blocked";
      result.reason = "login_or_captcha_or_risk_control";
      result.page_title = blocker.title;
      result.page_url = blocker.url;
      return result;
    }

    if (config.capture_mode === "direct") {
      const capture = await directCapture(tab, config, url);
      result.status = capture.capture_status === "complete" ? "saved" : "partial";
      result.saved_files = [capture.file];
      result.saved_file = capture.file;
      result.capture_status = capture.capture_status;
      result.title = capture.post.title;
      result.author = capture.post.author;
      result.published = capture.post.published;
      result.body_extracted = Boolean(capture.post.body);
      result.image_discovered_count = capture.post.images.length;
      result.image_saved_count = capture.image_saved_count;
      result.image_failed_count = capture.image_failed_count;
      result.comment_total_label = capture.post.total_label;
      result.comment_captured_count = capture.post.comments.length;
      result.comment_limit_hit = Boolean(
        capture.post.comment_load?.reached_limit
          || capture.post.comments.length >= config.chrome.comment_limit
      );
      result.snapshot_file = capture.snapshot_file;
      result.warnings = [];
      if (!capture.post.body) result.warnings.push("body_not_extracted");
      if (capture.image_failed_count) result.warnings.push("some_images_not_saved");
      if (result.comment_limit_hit) result.warnings.push("comment_limit_hit");
      if (!capture.post.comments.length) result.warnings.push("no_structured_comments_extracted");
      return result;
    }

    const clipResult = await triggerClipper(tab, config);
    if (!clipResult.valid.length) {
      result.status = "failed";
      result.reason = clipResult.invalid.length
        ? "blank_or_unresolved_clipping_created"
        : "clip_timeout_no_new_markdown";
      result.invalid_files = clipResult.invalid;
      return result;
    }

    result.status = "saved";
    result.saved_files = clipResult.valid;
    result.saved_file = clipResult.valid[0];
    result.invalid_files = clipResult.invalid;
    return result;
  } catch (error) {
    result.status = "failed";
    result.reason = error?.message || String(error);
    return result;
  } finally {
    result.finished_at = new Date().toISOString();
  }
}

async function writeManifest(config, manifest) {
  const batchDir = path.join(config.evidence_dir, config.batch_id);
  await fs.mkdir(batchDir, { recursive: true });
  const manifestPath = path.join(batchDir, "chrome-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifestPath;
}

async function readExistingManifest(config) {
  const manifestPath = path.join(config.evidence_dir, config.batch_id, "chrome-manifest.json");
  try {
    return JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

export async function runXhsObsidianClipper(options = {}) {
  const activeBrowser = options.browser || globalThis.browser;
  if (!activeBrowser) {
    throw new Error(
      "Chrome browser runtime is not initialized. Run setupBrowserRuntime and agent.browsers.get(\"extension\") first."
    );
  }

  const config = await readConfig(options.configPath, options.config || {});
  await activeBrowser.nameSession(`xhs-obsidian-clipper:${config.batch_id}`);

  const tab = options.tab || (await activeBrowser.tabs.new());
  const existing = config.resume ? await readExistingManifest(config) : null;
  const manifest = existing || {
    version: 2,
    batch_id: config.batch_id,
    query: config.query,
    max_items: config.max_items,
    vault_dir: config.vault_dir,
    clip_dir: relativeToVault(config, config.clip_dir),
    raw_dir: relativeToVault(config, config.raw_dir),
    asset_dir: relativeToVault(config, config.asset_dir),
    capture_mode: config.capture_mode,
    checkpoint_size: config.checkpoint_size,
    started_at: new Date().toISOString(),
    search_url: null,
    collected_links: [],
    results: [],
    safety: {
      reads_cookies_or_storage: false,
      bypasses_login_or_captcha: false,
      hard_max_items_enforced: config.hard_max_items,
      checkpoint_size: config.checkpoint_size,
    },
  };

  try {
    let links = Array.isArray(config.source_urls) ? config.source_urls.filter(Boolean) : [];
    const openFromSearchCard = !links.length;
    if (!links.length) {
      manifest.search = await openSearch(tab, config);
      manifest.search_url = manifest.search.requested_url;
      if (!manifest.search.confirmed) {
        manifest.status = "blocked";
        manifest.reason = "search_not_confirmed";
        return manifest;
      }
      const blocker = await pageBlockerState(tab);
      if (blocker.blocker) {
        manifest.status = "blocked";
        manifest.reason = "login_or_captcha_or_risk_control_on_search_page";
        manifest.page_title = blocker.title;
        manifest.page_url = blocker.url;
        return manifest;
      }
      links = await collectLinks(tab, config);
    } else {
      links = [...new Map(links.map((url) => [canonicalPostUrl(url), url])).values()];
      manifest.search = { skipped: true, reason: "source_urls_provided" };
    }
    links = links.slice(0, config.max_items);
    manifest.collected_links = links;
    const completed = new Set();
    for (const item of manifest.results || []) {
      if (!["saved", "partial"].includes(item.status) || !item.saved_file) continue;
      try {
        await fs.access(resolveFrom(config.vault_dir, item.saved_file));
        completed.add(item.normalized_url);
      } catch {
        // A missing raw note must be captured again even if an older manifest says saved.
      }
    }

    for (let index = 0; index < links.length && index < config.max_items; index++) {
      if (completed.has(normalizeUrl(links[index]))) continue;
      const result = await clipOne(tab, config, links[index], index + 1, { openFromSearchCard });
      manifest.results.push(result);
      manifest.last_checkpoint_at = new Date().toISOString();
      manifest.processed_count = manifest.results.length;
      await writeManifest(config, manifest);
      if (result.status === "blocked") {
        manifest.status = "blocked";
        manifest.reason = result.reason;
        break;
      }
      if (openFromSearchCard && index + 1 < links.length) {
        const reopened = await openSearch(tab, config);
        if (!reopened.confirmed) {
          manifest.status = "blocked";
          manifest.reason = "search_not_confirmed_after_post";
          break;
        }
      }
      await tab.playwright.waitForTimeout(config.chrome.between_posts_ms);
    }

    const saved = manifest.results.filter((item) => item.status === "saved").length;
    const partial = manifest.results.filter((item) => item.status === "partial").length;
    manifest.status = manifest.status === "blocked" ? "blocked" :
      (saved + partial ? "completed" : "no_items_saved");
    manifest.saved_count = saved;
    manifest.partial_count = partial;
    manifest.failed_count = manifest.results.filter(
      (item) => item.status === "failed"
    ).length;
    manifest.blocked_count = manifest.results.filter(
      (item) => item.status === "blocked"
    ).length;
    return manifest;
  } finally {
    manifest.finished_at = new Date().toISOString();
    manifest.manifest_path = await writeManifest(config, manifest);
    if (config.chrome.finalize !== false) {
      await activeBrowser.tabs.finalize({ keep: [] });
    }
    if (globalThis.nodeRepl?.write) {
      globalThis.nodeRepl.write(JSON.stringify(manifest, null, 2));
    }
  }
}

export const __test = {
  canonicalPostUrl,
  sanitizeSnapshot,
  renderRawPost,
  safeFilename,
};
