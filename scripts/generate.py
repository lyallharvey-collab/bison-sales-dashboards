#!/usr/bin/env python
"""
Generate one or all dashboards.

    python scripts/generate.py --all           # with live Odoo data baked in
    python scripts/generate.py --all --shell   # HTML only, no Odoo access

--shell is what CI uses. Live figures are served at request time by the Pages
Function in functions/<dashboard>/data.json.js, so the deployed HTML only needs
the shell; building it that way means CI needs no Odoo credentials at all.
Without --shell the generator still bakes real data in, which is handy for
local preview and for the JS/Python parity check (npm run livetest).
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
from dashboards.multi_build import build_multi_dashboard  # noqa: E402
from dashboards.multi_config_schema import is_multi_dashboard_config, load_multi_config  # noqa: E402
from dashboards.render import render_dashboard, render_multi_dashboard  # noqa: E402
from dashboards.shell_build import build_multi_shell, build_shell  # noqa: E402


def generate_one(config_path: Path, out_root: Path, shell: bool = False) -> str:
    if is_multi_dashboard_config(config_path):
        cfg = load_multi_config(config_path)
        if shell:
            print(f"[{cfg.name}] rendering shell ({len(cfg.panels)} panels, no Odoo)...")
            data = build_multi_shell(cfg)
        else:
            print(f"[{cfg.name}] pulling data from Odoo ({len(cfg.panels)} panels)...")
            data = build_multi_dashboard(cfg)
        render_multi_dashboard(data, out_root / cfg.name)
    else:
        cfg = load_config(config_path)
        if shell:
            print(f"[{cfg.name}] rendering shell (no Odoo)...")
            data = build_shell(cfg)
        else:
            print(f"[{cfg.name}] pulling data from Odoo...")
            data = build_dashboard(cfg)
        render_dashboard(data, out_root / cfg.name)
    print(f"[{cfg.name}] wrote {out_root / cfg.name / 'index.html'}")
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
    parser.add_argument(
        "--shell", action="store_true",
        help="render HTML from config only, without contacting Odoo (what CI uses)",
    )
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

    names = [generate_one(c, args.out, shell=args.shell) for c in configs]
    write_index(args.out, names)


if __name__ == "__main__":
    main()
