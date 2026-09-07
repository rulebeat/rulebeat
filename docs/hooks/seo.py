"""MkDocs hooks for search and AI discoverability (docs/mkdocs.yml, `hooks:`).

Three jobs, all stdlib, none of them touching the markdown that GitHub renders:

1. A per-page description. docs/public/*.md carries no front matter on purpose (the files keep
   rendering on plain GitHub), so every page used to ship the site-wide description. This derives
   one from each page's first prose paragraph and stores it in page.meta, where Material's base
   template already reads it for <meta name="description"> and overrides/main.html reads it for
   the Open Graph card and the structured data.
2. The FAQ's question-and-answer pairs (every H2 on faq.md is a question), stored in page.meta so
   overrides/main.html can emit FAQPage structured data for that one page.
3. llms.txt and llms-full.txt written into the built site, in the shape llmstxt.org describes:
   an index of every page with its description, and every page's markdown in nav order.

A page can still set its own description in front matter; this only fills in a missing one.
"""

from __future__ import annotations

import re
from pathlib import Path

# Long enough for positioning line 1 (163 characters) to survive whole on the home page.
DESCRIPTION_MAX = 170

_COUNT_MARKER = re.compile(r"<!--\s*count:[a-z0-9:-]+\s*-->")
_HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_EMPHASIS = re.compile(r"(\*\*|__|\*|_|`)")
_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_FENCE = re.compile(r"^(```|~~~)")

# Lines that are not prose: images, tables, block quotes, list items, HTML, headings.
_NOT_PROSE = re.compile(r"^\s*(!\[|\||>|[-*+]\s|\d+\.\s|<)")

# src_uri -> {title, url, markdown, description}, filled per page, read after the build.
_pages: dict[str, dict[str, str]] = {}


def _clean(text: str) -> str:
    text = _HTML_COMMENT.sub("", text)
    text = _LINK.sub(r"\1", text)
    text = _EMPHASIS.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def _paragraphs(markdown: str):
    """Yield (heading_or_None, paragraph) pairs: each prose paragraph with the H1/H2 above it."""
    heading = None
    buffer: list[str] = []
    in_fence = False
    for line in markdown.splitlines():
        if _FENCE.match(line):
            in_fence = not in_fence
            buffer = []
            continue
        if in_fence:
            continue
        match = _HEADING.match(line)
        if match:
            if buffer:
                yield heading, " ".join(buffer)
                buffer = []
            heading = match.group(2).strip()
            continue
        if not line.strip():
            if buffer:
                yield heading, " ".join(buffer)
                buffer = []
            continue
        if _NOT_PROSE.match(line):
            if buffer:
                yield heading, " ".join(buffer)
                buffer = []
            continue
        buffer.append(line.strip())
    if buffer:
        yield heading, " ".join(buffer)


def _truncate(text: str, limit: int = DESCRIPTION_MAX) -> str:
    if len(text) <= limit:
        return text
    head = text[:limit]
    # Prefer a sentence boundary, then a word boundary.
    for stop in (". ", "? ", "! "):
        cut = head.rfind(stop)
        if cut >= limit // 2:
            return head[: cut + 1]
    cut = head.rfind(" ")
    return (head[:cut] if cut > 0 else head).rstrip(",;:") + "..."


def _title(markdown: str, fallback: str) -> str:
    for line in markdown.splitlines():
        match = _HEADING.match(line)
        if match and len(match.group(1)) == 1:
            return _clean(match.group(2))
    return fallback


def first_paragraph(markdown: str) -> str:
    """The page's first prose paragraph, cut to description length.

    MkDocs renders templates without autoescaping, and the description lands inside a quoted
    HTML attribute, so double quotes become single ones here rather than breaking the tag.
    """
    for _heading, paragraph in _paragraphs(markdown):
        cleaned = _clean(paragraph)
        if cleaned:
            return _truncate(cleaned).replace('"', "'")
    return ""


def faq_pairs(markdown: str) -> list[dict[str, str]]:
    pairs: list[dict[str, str]] = []
    seen: set[str] = set()
    for heading, paragraph in _paragraphs(markdown):
        if not heading or not heading.endswith("?") or heading in seen:
            continue
        answer = _clean(paragraph)
        if answer:
            pairs.append({"question": _clean(heading), "answer": answer})
            seen.add(heading)
    return pairs


def on_page_markdown(markdown, page, config, files):
    if not page.meta.get("description"):
        description = first_paragraph(markdown)
        if description:
            page.meta["description"] = description
    if page.file.src_uri == "faq.md":
        page.meta["faq"] = faq_pairs(markdown)
    _pages[page.file.src_uri] = {
        "title": _title(markdown, page.file.name),
        "url": page.canonical_url or (config["site_url"] + page.url),
        "markdown": _COUNT_MARKER.sub("", markdown).strip(),
        "description": page.meta.get("description", ""),
    }
    return markdown


def _nav_order(nav) -> list[str]:
    order: list[str] = []

    def walk(items):
        for item in items:
            if isinstance(item, str):
                order.append(item)
            elif isinstance(item, dict):
                for value in item.values():
                    walk(value if isinstance(value, list) else [value])

    walk(nav or [])
    return order


def on_post_build(config):
    if not _pages:
        return
    ordered = [uri for uri in _nav_order(config.get("nav")) if uri in _pages]
    ordered += [uri for uri in _pages if uri not in ordered]
    site_dir = Path(config["site_dir"])
    site_url = config["site_url"]
    repo_url = config.get("repo_url", "")

    index = [
        f"# {config['site_name']}",
        "",
        f"> {config['site_description']}",
        "",
        "These pages describe RuleBeat as it ships today. Their source is the docs/public directory of",
        "the public repository, which is also where corrections go.",
        "",
        "## Documentation",
        "",
    ]
    for uri in ordered:
        entry = _pages[uri]
        suffix = f": {entry['description']}" if entry["description"] else ""
        index.append(f"- [{entry['title']}]({entry['url']}){suffix}")
    index += [
        "",
        "## Optional",
        "",
        "- [Website](https://rulebeat.com)",
        *([f"- [Source code]({repo_url})"] if repo_url else []),
        f"- [All pages as one file]({site_url}llms-full.txt)",
        "",
    ]
    (site_dir / "llms.txt").write_text("\n".join(index), encoding="utf-8")

    full = [f"# {config['site_name']}", "", f"> {config['site_description']}", ""]
    for uri in ordered:
        entry = _pages[uri]
        body = re.sub(r"^#\s+.*\n?", "", entry["markdown"], count=1)
        full += [f"# {entry['title']}", "", f"Source: {entry['url']}", "", body.strip(), "", "---", ""]
    (site_dir / "llms-full.txt").write_text("\n".join(full), encoding="utf-8")
