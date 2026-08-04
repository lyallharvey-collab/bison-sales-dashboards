"""
Build the *shell* of a dashboard payload from config alone — no Odoo access.

Since the live figures now come from a Pages Function at request time
(functions/<dashboard>/data.json.js), the generated HTML no longer needs real
data baked into it. It only needs the parts the Jinja template renders
server-side: title, theme, refresh interval, and — for multi-panel dashboards
— the panel grid (ids, types, columns, flex) and table headers.

Consequences, both deliberate:
  * `generate.py --shell` needs no Odoo credentials at all, which is why the
    GitHub Actions workflow no longer carries them.
  * `has_data` is False, so the page skips its initial paint and shows a
    loading state until the first live fetch resolves (a second or two).
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, timezone

import pandas as pd

from .config_schema import DashboardConfig
from .division_sources import MEASURES, PERIOD_LABELS, meter_bounds
from .multi_config_schema import MultiDashboardConfig, PanelConfig


def _empty_series(series) -> list[dict]:
    return [
        {
            "key": s.key,
            "label": s.label,
            "color": s.color,
            "data": [],
            "is_reference": bool(getattr(s, "extend_to_month_end", None) or getattr(s, "extend", False)),
        }
        for s in series
    ]


def build_shell(cfg: DashboardConfig) -> dict:
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "has_data": False,
        "name": cfg.name,
        "title": cfg.title,
        "chart_type": cfg.chart_type,
        "unit": cfg.unit,
        "currency_symbol": cfg.currency_symbol,
        "theme": cfg.theme,
        "logo_url": cfg.logo_url,
        "refresh_seconds": cfg.refresh_seconds,
        "labels": [],
        "series": _empty_series(cfg.series),
        "latest": {},
    }


def _shell_panel(p: PanelConfig, page_theme: dict, today: date) -> dict:
    theme = {**page_theme, **p.theme}
    base = {"id": p.id, "type": p.type, "theme": theme, "col": p.col, "flex": p.flex, "title": p.title}

    if p.type == "line_chart":
        # Axis labels are calendar facts, not Odoo data — emitting them means
        # the empty chart still draws its axes at the right scale before the
        # first fetch lands, instead of visibly reflowing afterwards.
        if p.granularity == "month":
            labels = [calendar.month_name[m] for m in range(1, 13)]
        else:
            month_start = today.replace(day=1)
            month_end = today.replace(day=calendar.monthrange(today.year, today.month)[1])
            labels = [ts.date().isoformat() for ts in pd.bdate_range(month_start, month_end)]
        return {
            **base,
            "chart_type": p.chart_type,
            "unit": p.unit,
            "currency_symbol": p.currency_symbol,
            "labels": labels,
            "series": _empty_series(p.series),
            "latest": {},
        }

    if p.type == "kpi":
        return {**base, "value": None, "caption": p.caption or p.title}

    if p.type == "meter_group":
        # The window and the measure are config/calendar facts, not Odoo data,
        # so the header can state what it's about before the first fetch lands —
        # same reasoning as emitting the axis labels above. The tubes themselves
        # are built in JS from the payload, like table rows.
        day_from, day_to = meter_bounds(p.period, today)
        return {
            **base,
            "unit": p.unit,
            "currency_symbol": p.currency_symbol,
            "measure": p.measure,
            "measure_label": MEASURES[p.measure]["label"],
            "period": p.period,
            "period_label": PERIOD_LABELS[p.period],
            "color": MEASURES[p.measure]["color"],
            "period_from": day_from.isoformat(),
            "period_to": day_to.isoformat(),
            "meters": [],
        }

    if p.type == "table":
        return {
            **base,
            "columns": [{"key": c.key, "label": c.label, "type": c.type} for c in p.columns],
            "rows": [],
        }

    raise ValueError(f"panel '{p.id}': unknown type '{p.type}'")


def build_multi_shell(cfg: MultiDashboardConfig, today: date | None = None) -> dict:
    today = today or date.today()
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "has_data": False,
        "name": cfg.name,
        "title": cfg.title,
        "refresh_seconds": cfg.refresh_seconds,
        "panels": [_shell_panel(p, cfg.theme, today) for p in cfg.panels],
    }
