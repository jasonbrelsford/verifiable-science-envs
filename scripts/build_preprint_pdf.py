"""Build the HLA-Bench preprint PDF from the markdown draft.

Neither pandoc nor a TeX toolchain is assumed to be installed. This script
instead:

1. Parses the front matter (title, italic byline/date line, licence line) off
   the top of `docs/paper/hla-bench-draft.md`.
2. Converts the remaining markdown body to HTML with the `markdown` package
   (tables, fenced code extensions enabled), inlines the referenced SVG
   figures directly into the HTML (so no external file fetch is needed by the
   renderer), and wraps it in a print stylesheet (serif body, 11pt, 1-inch
   margins, numbered `##`/`###` headings kept as written, styled tables, a
   page break before each top-level `##` section).
3. Shells out to a headless Chromium-family browser (Microsoft Edge by
   default) to print that HTML to `docs/paper/hla-bench-draft.pdf`.
4. Falls back to `pandoc` if it is found on PATH (kept for parity with
   `docs/PREPRINT_CHECKLIST.md`'s original command, and for any future
   machine/CI image that does have a TeX engine installed).

Usage:
    python scripts/build_preprint_pdf.py
    python scripts/build_preprint_pdf.py --md docs/paper/hla-bench-draft.md \
        --out docs/paper/hla-bench-draft.pdf

Browser discovery order (first match wins):
    1. --browser CLI flag
    2. PREPRINT_PDF_BROWSER environment variable
    3. Common Windows Edge/Chrome install paths
    4. `msedge` / `chrome` / `chromium` on PATH

On CI, set PREPRINT_PDF_BROWSER to the headless browser binary path (or
ensure one of the PATH names above resolves) rather than editing this file.
"""
from __future__ import annotations

import argparse
import html
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

CANDIDATE_BROWSER_PATHS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]

CANDIDATE_BROWSER_NAMES = ["msedge", "chrome", "chromium", "chromium-browser"]

FIGURE_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")


def find_browser(explicit: str | None) -> str:
    """Resolve a headless-capable Chromium-family browser binary."""
    if explicit:
        if Path(explicit).exists() or shutil.which(explicit):
            return explicit
        raise SystemExit(f"--browser path does not exist: {explicit}")

    import os

    env_path = os.environ.get("PREPRINT_PDF_BROWSER")
    if env_path:
        if Path(env_path).exists() or shutil.which(env_path):
            return env_path
        raise SystemExit(
            f"PREPRINT_PDF_BROWSER is set to {env_path!r} but that path was not found"
        )

    for path in CANDIDATE_BROWSER_PATHS:
        if Path(path).exists():
            return path

    for name in CANDIDATE_BROWSER_NAMES:
        found = shutil.which(name)
        if found:
            return found

    raise SystemExit(
        "No headless-capable browser found. Install Microsoft Edge or Google "
        "Chrome, or set PREPRINT_PDF_BROWSER to the full path of a Chromium-"
        "family browser binary, or pass --browser explicitly.\n"
        f"Checked fixed paths: {CANDIDATE_BROWSER_PATHS}\n"
        f"Checked PATH names: {CANDIDATE_BROWSER_NAMES}"
    )


def split_front_matter(text: str) -> tuple[str, str, str, str]:
    """Pull title / byline-italic-block / licence line off the top of the draft.

    Returns (title, byline_html, licence_html, remaining_markdown_body).
    The draft's own leading `# Title`, the following `*italic byline*` block,
    and the `**Licence:**` paragraph are rendered into a title block rather
    than as ordinary body markdown, so the PDF gets a real title page header
    instead of just another `<h1>`.
    """
    lines = text.splitlines()
    if not lines or not lines[0].startswith("# "):
        raise SystemExit("Expected the draft to start with a top-level '# Title' line")
    title = lines[0][2:].strip()

    idx = 1
    # Skip blank lines after the title.
    while idx < len(lines) and not lines[idx].strip():
        idx += 1

    byline_lines: list[str] = []
    while idx < len(lines) and lines[idx].strip():
        byline_lines.append(lines[idx])
        idx += 1
    byline_html = markdown_to_html("\n".join(byline_lines))

    while idx < len(lines) and not lines[idx].strip():
        idx += 1

    licence_lines: list[str] = []
    if idx < len(lines) and lines[idx].startswith("**Licence:**"):
        while idx < len(lines) and lines[idx].strip():
            licence_lines.append(lines[idx])
            idx += 1
    licence_html = markdown_to_html("\n".join(licence_lines)) if licence_lines else ""

    body = "\n".join(lines[idx:])
    return title, byline_html, licence_html, body


def markdown_to_html(md_text: str) -> str:
    import markdown as md

    # Note: the "smarty" extension (straight quotes -> typographic curly
    # quotes) is deliberately NOT enabled. The draft mixes prose quotes with
    # technical tokens like `'malformed_response'` and quoted allele strings;
    # converting those would risk mangling technical content, and some
    # PDF text-extraction tools do not map curly-quote glyphs cleanly back to
    # ASCII, which would show up as a false positive in copy/paste checks.
    return md.markdown(
        md_text,
        extensions=["tables", "fenced_code", "sane_lists"],
        output_format="html5",
    )


def inline_svg_figures(body_md: str, md_dir: Path) -> str:
    """Replace `![alt](figures/x.svg)` image refs with the SVG's literal markup.

    Embedding the SVG source directly (rather than leaving an <img src=...>
    reference) means the print renderer needs no external file fetch and the
    figure is guaranteed present in the output regardless of how the HTML is
    later served or printed.
    """

    def replace(match: re.Match) -> str:
        alt_text = match.group(1)
        rel_path = match.group(2).strip()
        fig_path = (md_dir / rel_path).resolve()
        if not fig_path.exists():
            raise SystemExit(f"Figure referenced in draft not found on disk: {fig_path}")
        if fig_path.suffix.lower() != ".svg":
            # Non-SVG figures: leave as a normal markdown image reference
            # pointing at a file:// URL so Chromium can still load it.
            return f"![{alt_text}]({fig_path.as_uri()})"
        svg_source = fig_path.read_text(encoding="utf-8")
        caption = html.escape(alt_text)
        return (
            '<figure class="preprint-figure">'
            f"{svg_source}"
            f"<figcaption>{caption}</figcaption>"
            "</figure>"
        )

    return FIGURE_RE.sub(replace, body_md)


def add_section_page_breaks(body_html: str) -> str:
    """Insert a page-break-before hook on each top-level (`<h2>`) section.

    We do this by tagging the h2 elements with a class the stylesheet keys
    off of, rather than mutating text content.
    """
    return re.sub(r"<h2>", '<h2 class="section-break">', body_html)


PRINT_CSS = """
@page {
    size: Letter;
    margin: 1in;
}
html, body {
    margin: 0;
    padding: 0;
}
body {
    font-family: Georgia, "Times New Roman", Times, serif;
    font-size: 11pt;
    line-height: 1.5;
    color: #111;
    max-width: 100%;
}
.title-block {
    text-align: left;
    margin-bottom: 1.5em;
}
.title-block h1 {
    font-size: 17pt;
    line-height: 1.3;
    margin: 0 0 0.6em 0;
}
.byline {
    font-style: italic;
    font-size: 10.5pt;
    color: #333;
    margin-bottom: 0.8em;
}
.licence {
    font-size: 9.5pt;
    color: #333;
    border-top: 1px solid #999;
    border-bottom: 1px solid #999;
    padding: 0.5em 0;
    margin-bottom: 1.2em;
}
.licence p { margin: 0.3em 0; }
h1, h2, h3, h4 {
    font-family: Georgia, "Times New Roman", Times, serif;
    font-weight: bold;
    page-break-after: avoid;
}
h2 { font-size: 14pt; margin-top: 1.6em; }
h2.section-break { break-before: page; page-break-before: always; }
h3 { font-size: 12.5pt; margin-top: 1.3em; }
h4 { font-size: 11.5pt; margin-top: 1.1em; }
p, li { orphans: 3; widows: 3; }
table {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
    font-size: 9.5pt;
    break-inside: avoid;
}
th, td {
    border: 1px solid #999;
    padding: 4px 7px;
    text-align: left;
    vertical-align: top;
}
th {
    background: #eee;
    font-weight: bold;
}
code, pre {
    font-family: "Consolas", "Courier New", monospace;
    font-size: 9.5pt;
    background: #f4f4f4;
}
pre {
    padding: 0.6em;
    overflow-x: auto;
    break-inside: avoid;
}
a { color: #1a4fa0; text-decoration: none; }
figure.preprint-figure {
    margin: 1.2em 0;
    text-align: center;
    break-inside: avoid;
}
figure.preprint-figure svg {
    max-width: 100%;
    height: auto;
}
figure.preprint-figure figcaption {
    font-size: 9.5pt;
    font-style: italic;
    color: #333;
    margin-top: 0.4em;
    text-align: left;
}
blockquote {
    margin: 0.8em 0;
    padding-left: 1em;
    border-left: 3px solid #999;
    color: #333;
}
"""


def build_html(title: str, byline_html: str, licence_html: str, body_html: str) -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{html.escape(title)}</title>
<style>{PRINT_CSS}</style>
</head>
<body>
<div class="title-block">
<h1>{html.escape(title)}</h1>
<div class="byline">{byline_html}</div>
<div class="licence">{licence_html}</div>
</div>
{body_html}
</body>
</html>
"""


def render_pdf_with_browser(browser_path: str, html_path: Path, pdf_path: Path) -> None:
    file_url = html_path.resolve().as_uri()
    cmd = [
        browser_path,
        "--headless=new",
        "--disable-gpu",
        f"--print-to-pdf={pdf_path.resolve()}",
        "--no-pdf-header-footer",
        file_url,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

    # Edge headless can return before the PDF file is fully flushed to disk
    # (observed on Windows over a few hundred ms); poll briefly rather than
    # failing on a transient race.
    import time

    deadline = time.monotonic() + 5
    while not pdf_path.exists() and time.monotonic() < deadline:
        time.sleep(0.2)

    if result.returncode != 0 or not pdf_path.exists():
        raise SystemExit(
            "Headless browser PDF rendering failed.\n"
            f"Command: {cmd}\n"
            f"Return code: {result.returncode}\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )


def try_pandoc(md_path: Path, pdf_path: Path) -> bool:
    """Attempt the pandoc path from docs/PREPRINT_CHECKLIST.md if pandoc is on PATH."""
    pandoc = shutil.which("pandoc")
    if not pandoc:
        return False
    cmd = [
        pandoc,
        str(md_path),
        "-o",
        str(pdf_path),
        "--pdf-engine=xelatex",
        "-V",
        "geometry:margin=1in",
        "--toc=false",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"pandoc found but failed ({result.returncode}); falling back to Edge headless.")
        print(result.stderr)
        return False
    return pdf_path.exists()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--md",
        default=str(REPO_ROOT / "docs" / "paper" / "hla-bench-draft.md"),
        help="Path to the markdown draft.",
    )
    parser.add_argument(
        "--out",
        default=str(REPO_ROOT / "docs" / "paper" / "hla-bench-draft.pdf"),
        help="Output PDF path.",
    )
    parser.add_argument(
        "--html-out",
        default=None,
        help="Optional path to also write the intermediate HTML (default: alongside --out).",
    )
    parser.add_argument(
        "--browser",
        default=None,
        help="Explicit path to a headless-capable Chromium-family browser binary.",
    )
    parser.add_argument(
        "--no-pandoc-fallback",
        action="store_true",
        help="Skip the pandoc-on-PATH attempt and always use the browser path.",
    )
    args = parser.parse_args()

    md_path = Path(args.md).resolve()
    pdf_path = Path(args.out).resolve()
    if not md_path.exists():
        raise SystemExit(f"Markdown draft not found: {md_path}")

    if not args.no_pandoc_fallback and try_pandoc(md_path, pdf_path):
        print(f"Built {pdf_path} with pandoc.")
        return

    try:
        import markdown  # noqa: F401
    except ImportError:
        raise SystemExit(
            "The 'markdown' package is required. Install it with:\n"
            "    pip install markdown"
        )

    raw_text = md_path.read_text(encoding="utf-8")
    title, byline_html, licence_html, body_md = split_front_matter(raw_text)
    body_md = inline_svg_figures(body_md, md_path.parent)
    body_html = markdown_to_html(body_md)
    body_html = add_section_page_breaks(body_html)
    full_html = build_html(title, byline_html, licence_html, body_html)

    html_out = Path(args.html_out).resolve() if args.html_out else pdf_path.with_suffix(".html")
    html_out.write_text(full_html, encoding="utf-8")
    print(f"Wrote intermediate HTML: {html_out}")

    browser_path = find_browser(args.browser)
    print(f"Using browser: {browser_path}")
    render_pdf_with_browser(browser_path, html_out, pdf_path)
    print(f"Built {pdf_path}")


if __name__ == "__main__":
    main()
