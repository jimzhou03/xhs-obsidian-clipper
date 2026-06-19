import fs from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  query: "德国 HiWi 申请",
  max_items: 20,
  batch_id: null,
  vault_dir: null,
  clip_dir: "Clippings",
  evidence_dir: "tmp/xhs-obsidian-clipper",
  chrome: {
    search_url:
      "https://www.xiaohongshu.com/search_result?keyword={query}&source=web_explore_feed",
    clipper_shortcut: ["Control", "Shift", "O"],
    save_keys: ["Enter"],
    open_delay_ms: 3000,
    after_save_delay_ms: 1200,
    between_posts_ms: 4500,
    navigation_timeout_ms: 45000,
    clip_timeout_ms: 60000,
    scroll_pause_ms: 1500,
    max_scrolls: 18,
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
  if (config.max_items > 20) {
    throw new Error("max_items must be <= 20 for this MVP.");
  }
  config.vault_dir = path.isAbsolute(config.vault_dir)
    ? config.vault_dir
    : path.join(cwdFallback(), config.vault_dir);
  config.clip_dir = resolveFrom(config.vault_dir, config.clip_dir);
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

async function clipOne(tab, config, url, index) {
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
    await tab.goto(url);
    await tab.playwright.waitForLoadState({
      state: "domcontentloaded",
      timeoutMs: config.chrome.navigation_timeout_ms,
    });

    const blocker = await pageBlockerState(tab);
    if (blocker.blocker) {
      result.status = "blocked";
      result.reason = "login_or_captcha_or_risk_control";
      result.page_title = blocker.title;
      result.page_url = blocker.url;
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
  const manifest = {
    version: 1,
    batch_id: config.batch_id,
    query: config.query,
    max_items: config.max_items,
    vault_dir: config.vault_dir,
    clip_dir: relativeToVault(config, config.clip_dir),
    started_at: new Date().toISOString(),
    search_url: null,
    collected_links: [],
    results: [],
    safety: {
      reads_cookies_or_storage: false,
      bypasses_login_or_captcha: false,
      max_items_enforced: 20,
    },
  };

  try {
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

    const links = await collectLinks(tab, config);
    manifest.collected_links = links;

    for (let index = 0; index < links.length && index < config.max_items; index++) {
      const result = await clipOne(tab, config, links[index], index + 1);
      manifest.results.push(result);
      if (result.status === "blocked") {
        manifest.status = "blocked";
        manifest.reason = result.reason;
        break;
      }
      await tab.playwright.waitForTimeout(config.chrome.between_posts_ms);
    }

    const saved = manifest.results.filter((item) => item.status === "saved").length;
    manifest.status = manifest.status || (saved ? "completed" : "no_items_saved");
    manifest.saved_count = saved;
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
      await activeBrowser.tabs.finalize({ keep: [{ tab, status: "handoff" }] });
    }
    if (globalThis.nodeRepl?.write) {
      globalThis.nodeRepl.write(JSON.stringify(manifest, null, 2));
    }
  }
}
