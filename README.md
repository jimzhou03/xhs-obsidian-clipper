# xhs-obsidian-clipper

一个给 Codex 使用的 Skill：根据用户在 Codex 里的自然语言需求，自动提取小红书检索关键词，使用用户已登录的 Chrome 小红书账号检索帖子，通过 Obsidian Web Clipper 保存到 Obsidian 的 `Clippings` 文件夹，然后读取这些剪藏并生成总结文档。

## 能做什么

- 从用户输入中自动提取小红书搜索关键词。
- 使用 Codex Chrome 插件控制用户自己的 Chrome。
- 打开小红书搜索结果页，收集帖子链接。
- 逐篇打开帖子，并触发 Obsidian Web Clipper 保存为 Markdown。
- 读取保存后的 `Clippings/*.md`，按来源去重、清洗页面噪声。
- 生成 evidence bundle、主题地图预览，以及可写入 Obsidian 的 `wiki/maps/小红书-<关键词>-<日期>.md`。
- 追加 `wiki/log.md`，保留批处理记录。

## 不能做什么

- 不绕过小红书登录、验证码、风控、付费墙或私密内容。
- 不读取 Chrome cookie、localStorage、密码或浏览器 profile。
- 不直接调用 Obsidian Web Clipper 未公开的内部接口。
- 不保证小红书页面结构长期稳定；页面变化时需要调整 runner。
- 不把小红书经验贴当成官方政策来源。税务、签证、学校规定、劳动法等内容必须二次核验。

## 推荐目录结构

```text
xhs-obsidian-clipper/
├── SKILL.md
├── agents/
│   └── openai.yaml
├── scripts/
│   ├── codex_chrome_xhs_clipper.mjs
│   └── analyze_clippings.py
├── templates/
│   └── xhs-web-clipper-template.md
├── config.example.json
├── .gitignore
└── README.md
```

## 安装为 Codex Skill

把本仓库复制或克隆到你的 Codex skills 目录：

```powershell
git clone https://github.com/jimzhou03/xhs-obsidian-clipper.git "$env:USERPROFILE\.codex\skills\xhs-obsidian-clipper"
```

如果已经克隆到其他位置，也可以把整个目录复制到：

```text
<你的用户目录>\.codex\skills\xhs-obsidian-clipper
```

之后在 Codex 中可以这样说：

```text
用 $xhs-obsidian-clipper 抓取小红书上关于雅思口语怎么学的 20 篇帖子，保存到 Obsidian，并总结成主题地图。
```

## 一次性准备

1. Chrome 已安装 Codex Chrome Extension。
2. Chrome 已安装 Obsidian Web Clipper。
3. 你已经用自己的账号登录小红书。
4. Obsidian Desktop 已打开目标 vault。
5. Web Clipper 保存目录设置为 `Clippings`。
6. 给 Obsidian Web Clipper 设置快捷键。自动化默认使用“打开 Obsidian Clipper”而不是“快速剪藏”，因为快速剪藏在部分 Windows/Obsidian URI 场景下会生成空的 `Untitled`。推荐配置是：

```text
Open Obsidian Clipper: Alt + Shift + C
Quick clip: 可保留 Alt + Shift + O，但不要作为自动化默认入口
不要使用 Ctrl + Shift + O：这是 Chrome 的书签管理器快捷键，会跳转到 chrome://bookmarks
```

如果你的快捷键不同，修改 `config.local.json` 里的：

```json
{
  "chrome": {
    "clipper_shortcut": ["Alt", "Shift", "C"],
    "open_delay_ms": 3000
  }
}
```

## 配置

复制配置文件：

```powershell
Copy-Item config.example.json config.local.json
```

常用字段：

```json
{
  "query": "雅思口语怎么学",
  "max_items": 20,
  "batch_id": "xhs-2026-06-16-ielts-speaking",
  "vault_dir": "<你的 Obsidian vault 路径>",
  "clip_dir": "Clippings",
  "output_dir": "wiki/maps"
}
```

说明：

- `query`：小红书检索词。实际使用 skill 时，Codex 会从用户输入中自动推断。
- `max_items`：本 MVP 限制最多 20 篇。
- `batch_id`：本次批次 ID，建议包含日期和关键词。
- `vault_dir`：Obsidian vault 路径。
- `clip_dir`：Web Clipper 原始剪藏目录。
- `output_dir`：总结文档输出目录。

## Web Clipper 模板

可以把 `templates/xhs-web-clipper-template.md` 的内容复制到 Obsidian Web Clipper 模板中。

推荐字段：

```yaml
---
title: "{{title}}"
source: "{{url}}"
author: "{{author}}"
published: "{{published}}"
created: {{date|date:"YYYY-MM-DD"}}
search_query:
batch_id:
tags:
  - clippings
  - xhs
---

{{content}}
```

`search_query` 和 `batch_id` 可以先留空；分析脚本会优先使用 runner 的 manifest 追踪本批文件。

## 运行 Chrome 剪藏

在 Codex 的 Chrome 插件环境里执行下面的 Node REPL 代码。路径要替换成你本机仓库位置。

```js
const { setupBrowserRuntime } = await import("<你的 Codex Chrome 插件目录>/scripts/browser-client.mjs");
await setupBrowserRuntime({ globals: globalThis });
globalThis.browser = await agent.browsers.get("extension");

const mod = await import("file:///<你的 Codex skills 目录>/xhs-obsidian-clipper/scripts/codex_chrome_xhs_clipper.mjs");
await mod.runXhsObsidianClipper({
  configPath: "<你的 Codex skills 目录>/xhs-obsidian-clipper/config.local.json"
});
```

运行后会生成：

```text
tmp/xhs-obsidian-clipper/<batch_id>/chrome-manifest.json
```

manifest 中会记录：

- 搜索关键词
- 收集到的链接
- 每篇帖子是否保存成功
- 新生成的 Markdown 文件路径
- 失败或阻塞原因

## 生成 Obsidian 总结文档

剪藏完成后运行：

```powershell
python -X utf8 scripts\analyze_clippings.py `
  --config config.local.json `
  --manifest tmp\xhs-obsidian-clipper\<batch_id>\chrome-manifest.json `
  --write-map `
  --update-log
```

输出包括：

```text
tmp/xhs-obsidian-clipper/<batch_id>/evidence.json
tmp/xhs-obsidian-clipper/<batch_id>/map-preview.md
wiki/maps/小红书-<关键词>-<YYYY-MM-DD>.md
```

如果只想测试解析，不写入 Obsidian：

```powershell
python -X utf8 scripts\analyze_clippings.py `
  --config config.example.json `
  --query "GRE 备考方法" `
  --batch-id dry-run-xhs-gre `
  --dry-run
```

## 推荐 Codex 使用方式

用户可以直接说：

```text
用 $xhs-obsidian-clipper 抓取小红书上关于 GRE 备考方法的 20 篇帖子，保存到 Obsidian，然后总结成一份主题地图。
```

Codex 应该执行：

1. 从输入中提取关键词，例如 `GRE 备考方法`。
2. 根据本地 vault 生成 `config.local.json` 或临时配置。
3. 使用 Chrome 插件打开小红书搜索页。
4. 如果未登录或遇到验证码，停止并让用户手动处理。
5. 调用 Web Clipper 保存帖子到 `Clippings`。
6. 读取本批剪藏，生成 evidence 和总结文档。
7. 在 Codex 中反馈保存数量、失败数量和生成文件路径。

## 当前限制

- Web Clipper 是浏览器扩展 UI 工作流，本项目不假设它有稳定公开批量 API。
- 小红书页面结构、登录策略和风控策略可能变化。
- 如果 Web Clipper 弹窗打开后 `Enter` 不能直接保存，需要手动调整 Web Clipper 设置或修改 `chrome.save_keys`。
- 总结脚本会做保守抽取和主题地图草稿；高质量结论仍建议 Codex 基于 `evidence.json` 再读一遍并润色。

## 排查：保存成空的 Untitled

如果按快捷键后 Obsidian 只创建 `Untitled.md`、`Untitled 1.md` 这类空文件，并且 frontmatter 里的 `title/source/created` 都没有值，说明当前保存动作没有拿到 Chrome 当前网页内容。优先按下面顺序检查：

1. 确认焦点在 Chrome 的网页标签页上，不在 Obsidian 窗口里。
2. 确认快捷键是在 `chrome://extensions/shortcuts` 里绑定给 **Obsidian Web Clipper**，不是 Obsidian 桌面端自己的快捷键。
3. 在 `General settings -> Vaults` 里只能填写 Obsidian vault 名，例如 `workplace`；不要填写 `Clippings/{{title}}`。如果这里已经有 `Clippings/{{title}}`，删除它或改成实际 vault 名。
4. `Clippings/{{title}}` 应该放在 Web Clipper 的模板保存路径、note location 或 path 字段里；如果模板只支持文件夹，就填 `Clippings`。
5. 模板正文必须包含 `{{content}}`；可以直接复制 `templates/xhs-web-clipper-template.md`。
6. 先在普通文章网页上测试，成功标准是 `Clippings` 下出现新 Markdown，且 `title`、`source`、正文都非空。
7. 小红书要打开具体帖子详情页后再 clip；搜索结果页可能只能保存空内容或弱内容。
8. 如果弹窗需要时间加载预览，把 `chrome.open_delay_ms` 调大到 `3000` 或 `5000`，不要过早按 `Enter`。

runner 会把这种空文件标记为 `blank_or_unresolved_clipping_created`，不会把它算作成功剪藏。若 `Alt+Shift+O` 快速剪藏持续生成空 `Untitled`，说明 Quick clip 到 Obsidian 的自动交接链路失败。改用 `Alt+Shift+C` 打开完整 Clipper 弹窗，确认弹窗里 `title/source/content` 已经出现后再保存。

## 开发校验

```powershell
python -X utf8 -m py_compile scripts\analyze_clippings.py
node --check scripts\codex_chrome_xhs_clipper.mjs
python -X utf8 "$env:USERPROFILE\.codex\skills\.system\skill-creator\scripts\quick_validate.py" .
```

## 许可

未指定。发布前建议补充 `LICENSE`。
