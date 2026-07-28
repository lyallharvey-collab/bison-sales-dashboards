#!/usr/bin/env python
"""
Generate one or all dashboards.

    python scripts/generate.py --config config/sales_graph.yaml
    python scripts/generate.py --all
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

from dashboards.build import build_dashboard  # noqa: E402
from dashboards.config_schema import load_config  # noqa: E402
from dashboards.render import render_dashboard  # noqa: E402


def generate_one(config_path: Path, out_root: Path) -> str:
    cfg = load_config(config_path)
    print(f"[{cfg.name}] pulling data from Odoo...")
    data = build_dashboard(cfg)
    out_dir = out_root / cfg.name
    render_dashboard(data, out_dir)
    print(f"[{cfg.name}] wrote {out_dir / 'index.html'}")
    return cfg.name


def write_index(out_root: Path, names: list[str]) -> None:
    """A tiny landing page linking every generated dashboard, so the Pages
    site root isn't a 404 — point the TV at /<name>/ directly once you know
    which one it should show."""
    links = "\n".join(f'<li><a href="./{n}/">{n}</a></li>' for n in sorted(names))
    (out_root / "index.html").write_text(
        f"<!doctype html><meta charset=utf-8><title>Dashboards</title>"
        f"<h1>Dashboards</h1><ul>{links}</ul>",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, help="path to a single dashboard YAML file")
    parser.add_argument("--all", action="store_true", help="generate every *.yaml in config/")
    parser.add_argument("--out", type=Path, default=ROOT / "output", help="output directory")
    parser.add_argument("--env-file", type=Path, default=ROOT / ".env")
    args = parser.parse_args()

    if args.env_file.exists():
        load_dotenv(args.env_file)

    if args.all:
        configs = sorted((ROOT / "config").glob("*.yaml"))
        if not configs:
            parser.error(f"no *.yaml files found in {ROOT / 'config'}")
    elif args.config:
        configs = [args.config]
    else:
        parser.error("pass --config <file> or --all")

    names = [generate_one(c, args.out) for c in configs]
    write_index(args.out, names)


if __name__ == "__main__":
    main()
