#!/usr/bin/env python3
"""Make a Quarto output self-contained for offline HTML and PDF viewing."""
import re
import shutil
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
entry = Path(sys.argv[2]).resolve()
assets = root / "offline-assets"
shutil.copytree("/opt/slide-assets", assets, dirs_exist_ok=True)

for file in root.rglob("*"):
    if assets in file.parents or not file.is_file() or file.suffix not in (".html", ".css"):
        continue
    text = file.read_text(encoding="utf-8")
    prefix = file.parent.relative_to(root)
    relative = ("../" * len(prefix.parts)) + "offline-assets/"
    text = text.replace("https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/", relative + "katex/")
    text = text.replace("https://cdn.jsdelivr.net/npm/mathjax@2.7.9/", relative + "mathjax/")
    if file == entry:
        text = text.replace("<head>", "<head><style>html.print-pdf .reveal .slide-menu-button,html.print-pdf .annotate-dock{display:none!important}</style>", 1)
        text = text.replace("Reveal.initialize({", "Reveal.initialize({scrollActivationWidth: 0,", 1)
    text = re.sub(r"@import\s+url\(['\"]https://fonts.googleapis.com/[^)'\"]+['\"]\)\s*;", f'@import url("{relative}fonts.css");', text)
    file.write_text(text, encoding="utf-8")

# Never certify a PDF if its text or math requires an unavailable CDN.
for file in root.rglob("*"):
    if assets in file.parents or not file.is_file() or file.suffix not in (".html", ".css"):
        continue
    text = file.read_text(encoding="utf-8")
    if re.search(r"https://(?:cdn\.jsdelivr\.net/npm/(?:katex|mathjax)/|fonts\.googleapis\.com/)", text):
        raise SystemExit(f"Unbundled PDF dependency in {file}")
print(entry.relative_to(root))
