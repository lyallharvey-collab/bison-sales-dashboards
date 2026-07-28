"""Render a built dashboard payload to a self-contained HTML file + sibling data.json."""

from __future__ import annotations

import json
from pathlib import Path

from jinja2 import Environment, FileSystemLoader

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"


def _tojson(value) -> str:
    # Safe to inline inside a <script> block: escapes "</script>" and similar.
    return json.dumps(value).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


_env = Environment(loader=FileSystemLoader(str(TEMPLATES_DIR)), autoescape=False)
_env.filters["tojson"] = _tojson


def render_dashboard(data: dict, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    template = _env.get_template("dashboard.html.j2")
    html = template.render(data=data, theme=data.get("theme", {}))
    (out_dir / "index.html").write_text(html, encoding="utf-8")

    (out_dir / "data.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
