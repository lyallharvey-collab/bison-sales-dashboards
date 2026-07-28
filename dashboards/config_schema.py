"""Dashboard config: load + validate the YAML files in config/."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class SeriesConfig:
    key: str
    label: str
    color: str
    source: str  # "read_group" or a name from special_sources.COMPOSITE_SOURCES
    model: str | None = None
    domain: list = field(default_factory=list)
    date_field: str | None = None
    measure: str | None = None
    cumulative: bool = True
    # If true, draw this series across the whole month (targets/pace lines).
    # If false, stop at today and leave the rest of the month blank (actuals).
    extend_to_month_end: bool = False


@dataclass
class DashboardConfig:
    name: str
    title: str
    chart_type: str
    unit: str  # "currency" | "number"
    currency_symbol: str
    theme: dict
    series: list[SeriesConfig]
    refresh_seconds: int = 300
    logo_url: str | None = None


def load_config(path: str | Path) -> DashboardConfig:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    series = [SeriesConfig(**s) for s in raw["series"]]
    return DashboardConfig(
        name=raw["name"],
        title=raw["title"],
        chart_type=raw.get("chart_type", "line"),
        unit=raw.get("unit", "currency"),
        currency_symbol=raw.get("currency_symbol", "£"),
        theme=raw.get("theme", {}),
        series=series,
        refresh_seconds=raw.get("refresh_seconds", 300),
        logo_url=raw.get("logo_url"),
    )
