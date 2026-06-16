from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


NOISE_PATTERNS = [
    re.compile(r"^笔记$"),
    re.compile(r"^用户$"),
    re.compile(r"^问点点ai$", re.I),
    re.compile(r"^筛选$"),
    re.compile(r"^回到顶部$"),
    re.compile(r"^加载中$"),
    re.compile(r"^共\s*\d+\s*条评论$"),
    re.compile(r"^\d+\s*/\s*\d+$"),
    re.compile(r"^\d+$"),
]

SUGGESTION_MARKERS = [
    "建议",
    "应该",
    "可以",
    "不要",
    "需要",
    "尽量",
    "优先",
    "注意",
    "一定",
    "最好",
    "必须",
]

UNCERTAIN_MARKERS = [
    "因人而异",
    "分情况",
    "不一定",
    "可能",
    "看情况",
    "取决于",
    "不同",
    "无法判断",
    "需要确认",
    "有的",
    "少部分",
]

DOMAIN_TERMS = [
    "Hiwi",
    "HIWI",
    "Tutor",
    "SHK",
    "实习",
    "学生工",
    "Werkstudent",
    "Pflichtpraktikum",
    "Freiwilliges Praktikum",
    "企业论文",
    "简历",
    "动机信",
    "面试",
    "HR",
    "导师",
    "教授",
    "博士生",
    "教研组",
    "成绩单",
    "邮件",
    "STAR",
    "Glassdoor",
    "Kununu",
    "LinkedIn",
    "学校邮箱",
    "Info Board",
    "工资",
    "工时",
    "税",
    "六级税",
    "科研",
    "大厂",
    "车企",
]


def load_json(path: Path | None) -> dict[str, Any]:
    if not path:
        return {}
    return json.loads(path.read_text(encoding="utf-8-sig"))


def value_from_config(config: dict[str, Any], key: str, default: Any) -> Any:
    value = config.get(key, default)
    if value in (None, ""):
        return default
    return value


def resolve_path(vault_dir: Path, value: str | Path) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return vault_dir / path


def strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text

    end = None
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            end = index
            break
    if end is None:
        return {}, text

    meta: dict[str, Any] = {}
    current_key: str | None = None
    for raw_line in lines[1:end]:
        line = raw_line.rstrip()
        key_match = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$", line)
        if key_match:
            key = key_match.group(1)
            value = key_match.group(2).strip()
            if value == "":
                meta[key] = []
                current_key = key
            else:
                meta[key] = strip_quotes(value)
                current_key = key
            continue

        item_match = re.match(r"^\s*-\s*(.*)$", line)
        if item_match and current_key:
            if not isinstance(meta.get(current_key), list):
                meta[current_key] = [meta[current_key]]
            meta[current_key].append(strip_quotes(item_match.group(1)))

    body = "\n".join(lines[end + 1 :])
    return meta, body


def normalize_source(source: str) -> str:
    source = source.strip()
    if not source:
        return ""
    parsed = urlparse(source)
    if not parsed.scheme or not parsed.netloc:
        return source
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/")


def obsidian_link(path: Path, vault_dir: Path, title: str) -> str:
    try:
        rel = path.resolve().relative_to(vault_dir.resolve())
    except ValueError:
        rel = path
    link_path = rel.as_posix()
    if link_path.endswith(".md"):
        link_path = link_path[:-3]
    safe_title = title.replace("[", "").replace("]", "").strip() or path.stem
    return f"[[{link_path}|{safe_title}]]"


def safe_filename(value: str, fallback: str = "topic") -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", value)
    value = re.sub(r"\s+", " ", value).strip(" .-")
    if not value:
        value = fallback
    return value[:60]


def clean_markdown(text: str) -> str:
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r"\1", text)
    text = re.sub(r"https?://\S+", "", text)
    text = text.replace("\t", " ")

    cleaned_lines: list[str] = []
    for raw_line in text.splitlines():
        line = re.sub(r"\s+", " ", raw_line).strip()
        if not line:
            continue
        if any(pattern.match(line) for pattern in NOISE_PATTERNS):
            continue
        if line.startswith("![](") or line.startswith("[![]("):
            continue
        cleaned_lines.append(line)

    return "\n".join(cleaned_lines).strip()


def split_sentences(text: str) -> list[str]:
    normalized = re.sub(r"\s+", " ", text).strip()
    parts = re.split(r"(?<=[。！？!?])\s*|[；;]\s*", normalized)
    return [part.strip(" -") for part in parts if len(part.strip()) >= 12]


def short_excerpt(text: str, max_len: int = 130) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= max_len:
        return text
    return text[: max_len - 1].rstrip() + "..."


def extract_marked_sentences(
    items: list[dict[str, Any]], markers: list[str], limit: int
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        for sentence in split_sentences(item["text"]):
            if not any(marker.lower() in sentence.lower() for marker in markers):
                continue
            key = re.sub(r"\W+", "", sentence.lower())[:80]
            if key in seen:
                continue
            seen.add(key)
            results.append(
                {
                    "sentence": sentence,
                    "title": item["title"],
                    "file": item["file"],
                    "source": item["source"],
                }
            )
            if len(results) >= limit:
                return results
    return results


def count_terms(items: list[dict[str, Any]]) -> list[tuple[str, int]]:
    blob = "\n".join(item["text"] for item in items)
    counts: Counter[str] = Counter()
    for term in DOMAIN_TERMS:
        count = len(re.findall(re.escape(term), blob, flags=re.I))
        if count:
            canonical = "Hiwi" if term.upper() == "HIWI" else term
            counts[canonical] += count

    for tag in re.findall(r"#([\w\u4e00-\u9fff-]{2,20})", blob):
        counts[tag] += 1

    return counts.most_common(12)


def item_from_file(path: Path, vault_dir: Path) -> dict[str, Any] | None:
    try:
        raw = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        raw = path.read_text(encoding="utf-8", errors="replace")

    meta, body = parse_frontmatter(raw)
    title = str(meta.get("title") or path.stem).strip()
    source = str(meta.get("source") or "").strip()
    source_key = normalize_source(source) or str(path.resolve())
    description = clean_markdown(str(meta.get("description") or ""))
    body_text = clean_markdown(body)
    text = description if len(description) >= 40 else body_text
    if not text:
        return None

    tags = meta.get("tags") if isinstance(meta.get("tags"), list) else []
    created = str(meta.get("created") or "")
    try:
        rel_file = path.resolve().relative_to(vault_dir.resolve()).as_posix()
    except ValueError:
        rel_file = path.as_posix()

    return {
        "title": title,
        "source": source,
        "source_key": source_key,
        "created": created,
        "file": rel_file,
        "absolute_file": str(path.resolve()),
        "tags": tags,
        "text": text,
        "excerpt": short_excerpt(text),
        "char_count": len(text),
        "modified_at": dt.datetime.fromtimestamp(path.stat().st_mtime).isoformat(
            timespec="seconds"
        ),
    }


def files_from_manifest(manifest_path: Path, vault_dir: Path) -> list[Path]:
    manifest = load_json(manifest_path)
    paths: list[Path] = []
    for result in manifest.get("results", []):
        for key in ("saved_file", "saved_files"):
            value = result.get(key)
            if isinstance(value, str):
                paths.append(resolve_path(vault_dir, value))
            elif isinstance(value, list):
                paths.extend(resolve_path(vault_dir, entry) for entry in value)
    return paths


def discover_items(
    clip_dir: Path,
    vault_dir: Path,
    max_items: int,
    manifest_path: Path | None = None,
) -> list[dict[str, Any]]:
    if manifest_path:
        candidates = [path for path in files_from_manifest(manifest_path, vault_dir) if path.exists()]
    else:
        candidates = sorted(
            clip_dir.glob("*.md"), key=lambda path: path.stat().st_mtime, reverse=True
        )

    deduped: dict[str, dict[str, Any]] = {}
    for path in candidates:
        item = item_from_file(path, vault_dir)
        if not item:
            continue
        existing = deduped.get(item["source_key"])
        if not existing or item["modified_at"] > existing["modified_at"]:
            deduped[item["source_key"]] = item
        if len(deduped) >= max_items and not manifest_path:
            break

    items = list(deduped.values())
    items.sort(key=lambda item: item["modified_at"], reverse=True)
    return items[:max_items]


def build_evidence(
    items: list[dict[str, Any]], query: str, batch_id: str
) -> dict[str, Any]:
    suggestions = extract_marked_sentences(items, SUGGESTION_MARKERS, limit=14)
    uncertainties = extract_marked_sentences(items, UNCERTAIN_MARKERS, limit=10)
    terms = count_terms(items)
    return {
        "version": 1,
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "query": query,
        "batch_id": batch_id,
        "source_count": len(items),
        "top_terms": [{"term": term, "count": count} for term, count in terms],
        "suggestions": suggestions,
        "uncertainties": uncertainties,
        "items": [
            {
                key: item[key]
                for key in (
                    "title",
                    "source",
                    "source_key",
                    "created",
                    "file",
                    "tags",
                    "excerpt",
                    "char_count",
                    "modified_at",
                )
            }
            for item in items
        ],
    }


def render_map(
    evidence: dict[str, Any], items: list[dict[str, Any]], vault_dir: Path
) -> str:
    today = dt.date.today().isoformat()
    query = evidence["query"]
    batch_id = evidence["batch_id"]
    title = f"小红书-{query}-{today}"
    source_count = evidence["source_count"]
    top_terms = evidence.get("top_terms", [])
    term_text = "、".join(
        f"{entry['term']}({entry['count']})" for entry in top_terms[:8]
    )
    if not term_text:
        term_text = "未提取到稳定高频词"

    lines = [
        "---",
        f'title: "{title}"',
        "type: xhs_topic_map",
        f"created: {today}",
        f"updated: {today}",
        f"source_count: {source_count}",
        f'query: "{query}"',
        f'batch_id: "{batch_id}"',
        "tags:",
        "  - xhs",
        "  - clippings",
        "  - topic-map",
        "---",
        "",
        f"# 小红书：{query}",
        "",
        "## 主题说明",
        "",
        f"- 本页基于 `{batch_id}` 批次的 {source_count} 篇小红书剪藏生成。",
        "- 原始剪藏保留在 `Clippings/`；本页只做来源约束下的归纳，不补充剪藏外事实。",
        "- 涉及政策、税务、工时、学校规定或签证约束的信息，应再用官方来源核验。",
        "",
        "## 核心观察",
        "",
        f"- 高频主题：{term_text}。",
        "- 本批资料更适合沉淀为经验清单和准备流程；不适合作为法规或学校政策的唯一依据。",
        "",
        "## 常见建议",
        "",
    ]

    suggestions = evidence.get("suggestions", [])
    if suggestions:
        for suggestion in suggestions[:10]:
            item_path = resolve_path(vault_dir, suggestion["file"])
            link = obsidian_link(item_path, vault_dir, suggestion["title"])
            lines.append(f"- {short_excerpt(suggestion['sentence'], 180)} 来源：{link}")
    else:
        lines.append("- 本批资料中未稳定抽取到建议句，需要人工复核原始剪藏。")

    lines.extend(["", "## 可能冲突或不确定", ""])
    uncertainties = evidence.get("uncertainties", [])
    if uncertainties:
        for uncertainty in uncertainties[:8]:
            item_path = resolve_path(vault_dir, uncertainty["file"])
            link = obsidian_link(item_path, vault_dir, uncertainty["title"])
            lines.append(f"- {short_excerpt(uncertainty['sentence'], 180)} 来源：{link}")
    else:
        lines.append("- 暂未抽取到明显冲突或不确定表达。")

    lines.extend(["", "## 可行动清单", ""])
    action_sentences = suggestions[:8]
    if action_sentences:
        for suggestion in action_sentences:
            sentence = short_excerpt(suggestion["sentence"], 150)
            if sentence.startswith(("不要", "先", "尽量", "一定", "注意")):
                action = sentence
            else:
                action = f"核对并执行：{sentence}"
            lines.append(f"- [ ] {action}")
    else:
        lines.append("- [ ] 人工复核本批剪藏，补充行动项。")

    lines.extend(["", "## 来源索引", ""])
    for item in items:
        link = obsidian_link(resolve_path(vault_dir, item["file"]), vault_dir, item["title"])
        source = item["source"]
        source_part = f" - [原链接]({source})" if source else ""
        lines.append(f"- {link}{source_part}")

    lines.extend(
        [
            "",
            "## 相关页面",
            "- [[wiki/maps/德国生活类地图|德国生活类地图]]",
            "- [[wiki/sources|来源摘要索引]]",
            "- [[wiki/questions|高价值问答索引]]",
            "",
            "## 后续问题",
            "- 哪些建议需要用学校官网、企业招聘页或德国官方规定二次确认？",
            "- 哪些经验贴可以转化为个人求职材料检查清单？",
        ]
    )
    return "\n".join(lines) + "\n"


def append_log(log_path: Path, query: str, batch_id: str, source_count: int, map_path: Path, evidence_path: Path, vault_dir: Path) -> None:
    timestamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        rel_map = map_path.resolve().relative_to(vault_dir.resolve()).as_posix()
    except ValueError:
        rel_map = map_path.as_posix()
    try:
        rel_evidence = evidence_path.resolve().relative_to(vault_dir.resolve()).as_posix()
    except ValueError:
        rel_evidence = evidence_path.as_posix()

    entry = (
        "\n## 小红书剪藏主题地图记录\n\n"
        f"- 记录时间：{timestamp} +08:00\n"
        f"- 批次：`{batch_id}`\n"
        f"- 检索词：{query}\n"
        f"- 有效来源数：{source_count}\n"
        f"- 生成页面：`{rel_map}`\n"
        f"- Evidence：`{rel_evidence}`\n"
    )
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(entry)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Analyze Obsidian Web Clipper notes from Xiaohongshu and build an evidence bundle/topic map."
    )
    parser.add_argument("--config", type=Path, help="Path to config JSON.")
    parser.add_argument("--query", help="Search query represented by this batch.")
    parser.add_argument("--batch-id", help="Batch id for evidence and map metadata.")
    parser.add_argument("--vault-dir", type=Path, help="Obsidian vault directory.")
    parser.add_argument("--clip-dir", type=Path, help="Directory containing clipped Markdown files.")
    parser.add_argument("--output-dir", type=Path, help="Directory for final topic maps.")
    parser.add_argument("--evidence-dir", type=Path, help="Directory for evidence bundles.")
    parser.add_argument("--manifest", type=Path, help="Chrome runner manifest JSON.")
    parser.add_argument("--max-items", type=int, help="Maximum sources to analyze.")
    parser.add_argument("--write-map", action="store_true", help="Write the final map into output_dir.")
    parser.add_argument("--update-log", action="store_true", help="Append the batch record to wiki/log.md.")
    parser.add_argument("--dry-run", action="store_true", help="Write evidence and a map preview only.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = load_json(args.config)

    vault_dir = args.vault_dir or Path(value_from_config(config, "vault_dir", "."))
    vault_dir = vault_dir.resolve()
    query = args.query or str(value_from_config(config, "query", "未命名检索"))
    batch_id = args.batch_id or str(
        value_from_config(
            config,
            "batch_id",
            f"xhs-{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}",
        )
    )
    max_items = args.max_items or int(value_from_config(config, "max_items", 20))
    if max_items > 20:
        raise ValueError("max_items must be <= 20 for this MVP.")

    clip_dir = resolve_path(vault_dir, args.clip_dir or value_from_config(config, "clip_dir", "Clippings"))
    output_dir = resolve_path(vault_dir, args.output_dir or value_from_config(config, "output_dir", "wiki/maps"))
    evidence_root = resolve_path(vault_dir, args.evidence_dir or value_from_config(config, "evidence_dir", "tmp/xhs-obsidian-clipper"))
    manifest_path = args.manifest.resolve() if args.manifest else None

    items = discover_items(clip_dir, vault_dir, max_items=max_items, manifest_path=manifest_path)
    evidence = build_evidence(items, query=query, batch_id=batch_id)

    batch_dir = evidence_root / batch_id
    batch_dir.mkdir(parents=True, exist_ok=True)
    evidence_path = batch_dir / "evidence.json"
    evidence_path.write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    map_text = render_map(evidence, items, vault_dir)
    preview_path = batch_dir / "map-preview.md"
    preview_path.write_text(map_text, encoding="utf-8")

    map_path: Path | None = None
    if args.write_map and not args.dry_run:
        output_dir.mkdir(parents=True, exist_ok=True)
        map_path = output_dir / f"{safe_filename(f'小红书-{query}-{dt.date.today().isoformat()}')}.md"
        map_path.write_text(map_text, encoding="utf-8")
        if args.update_log:
            append_log(
                vault_dir / "wiki" / "log.md",
                query=query,
                batch_id=batch_id,
                source_count=len(items),
                map_path=map_path,
                evidence_path=evidence_path,
                vault_dir=vault_dir,
            )

    summary = {
        "batch_id": batch_id,
        "query": query,
        "source_count": len(items),
        "evidence_path": str(evidence_path),
        "preview_path": str(preview_path),
        "map_path": str(map_path) if map_path else None,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
