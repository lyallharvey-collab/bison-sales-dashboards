"""Config schema for multi-panel dashboards (several charts/KPIs/tables on
one screen) — a separate, independent shape from the single-chart
DashboardConfig in config_schema.py, since the two aren't structurally
compatible and the single-chart dashboards already in production shouldn't
need to change to make room for this."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class PanelSeriesConfig:
    key: str
    label: str
    color: str
    source: str  # "read_group" or a name from special_sources.COMPOSITE_SOURCES
    model: str | None = None
    domain: list = field(default_factory=list)
    date_field: str | None = None
    measure: str | None = None
    cumulative: bool = True
    # Draw across the whole period (month/year) vs stop at "today" and leave
    # the rest blank. Granularity-agnostic — a panel's own `granularity`
    # decides whether "the whole period" means month-end or year-end.
    extend: bool = False


@dataclass
class TableColumn:
    key: str
    label: str
    type: str = "text"  # text | number | currency


@dataclass
class PanelConfig:
    id: str
    type: str  # line_chart | kpi | table
    title: str = ""
    theme: dict = field(default_factory=dict)
    # Layout: which column this panel stacks in, and its relative height
    # weight within that column (CSS flex-grow) — e.g. a short KPI tile
    # (flex: 3) above a taller table (flex: 6).
    col: str = "left"
    flex: float = 1
    # line_chart
    granularity: str = "day"  # day | month
    chart_type: str = "line"
    unit: str = "currency"
    currency_symbol: str = "£"
    series: list[PanelSeriesConfig] = field(default_factory=list)
    # kpi
    source: str | None = None
    caption: str | None = None
    # table
    columns: list[TableColumn] = field(default_factory=list)


@dataclass
class MultiDashboardConfig:
    name: str
    title: str
    refresh_seconds: int = 300
    theme: dict = field(default_factory=dict)  # page-level default; panels can override
    panels: list[PanelConfig] = field(default_factory=list)


def is_multi_dashboard_config(path: str | Path) -> bool:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    return "panels" in raw


def load_multi_config(path: str | Path) -> MultiDashboardConfig:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    panels = []
    for p in raw["panels"]:
        series = [PanelSeriesConfig(**s) for s in p.get("series", [])]
        columns = [TableColumn(**c) for c in p.get("columns", [])]
        panels.append(PanelConfig(
            id=p["id"],
            type=p["type"],
            title=p.get("title", ""),
            theme=p.get("theme", {}),
            col=p.get("col", "left"),
            flex=p.get("flex", 1),
            granularity=p.get("granularity", "day"),
            chart_type=p.get("chart_type", "line"),
            unit=p.get("unit", "currency"),
            currency_symbol=p.get("currency_symbol", "£"),
            series=series,
            source=p.get("source"),
            caption=p.get("caption"),
            columns=columns,
        ))
    return MultiDashboardConfig(
        name=raw["name"],
        title=raw["title"],
        refresh_seconds=raw.get("refresh_seconds", 300),
        theme=raw.get("theme", {}),
        panels=panels,
    )
