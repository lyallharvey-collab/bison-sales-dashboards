"""Turn a MultiDashboardConfig into the JSON payload the multi-panel
template consumes. Each panel type (line_chart/kpi/table) has its own
builder; line_chart panels can be daily (reuses build.build_dashboard
directly) or monthly (a dedicated year-to-date builder, since the date
bounds/bucketing are genuinely different from the daily case)."""

from __future__ import annotations

import calendar
from datetime import date, datetime, timezone

import pandas as pd

from . import crm_sources
from .build import build_dashboard as _build_daily_chart
from .config_schema import DashboardConfig, SeriesConfig
from .data_sources import read_group_monthly
from .multi_config_schema import MultiDashboardConfig, PanelConfig, PanelSeriesConfig
from .odoo_client import OdooClient, get_client
from .special_sources import COMPOSITE_SOURCES


def _as_old_series(series: list[PanelSeriesConfig]) -> list[SeriesConfig]:
    return [
        SeriesConfig(
            key=s.key, label=s.label, color=s.color, source=s.source,
            model=s.model, domain=s.domain, date_field=s.date_field, measure=s.measure,
            cumulative=s.cumulative, extend_to_month_end=s.extend,
        )
        for s in series
    ]


def _build_daily_line_chart(panel: PanelConfig, today: date) -> dict:
    old_cfg = DashboardConfig(
        name=panel.id, title=panel.title, chart_type=panel.chart_type,
        unit=panel.unit, currency_symbol=panel.currency_symbol, theme={},
        series=_as_old_series(panel.series),
    )
    raw = _build_daily_chart(old_cfg, today=today)
    return {
        "title": panel.title, "chart_type": raw["chart_type"], "unit": raw["unit"],
        "currency_symbol": raw["currency_symbol"], "labels": raw["labels"],
        "series": raw["series"], "latest": raw["latest"],
    }


def _build_monthly_line_chart(client: OdooClient, panel: PanelConfig, today: date) -> dict:
    year_start = today.replace(month=1, day=1)
    year_end = today.replace(month=12, day=31)
    months = [date(today.year, m, 1) for m in range(1, 13)]

    series_out = []
    latest = {}
    for s in panel.series:
        month_to = year_end if s.extend else min(today, year_end)

        if s.source == "read_group":
            if not (s.model and s.date_field and s.measure):
                raise ValueError(f"panel '{panel.id}' series '{s.key}': read_group needs model/date_field/measure")
            monthly = read_group_monthly(client, s.model, s.domain, s.date_field, s.measure, year_start, month_to)
        elif s.source in COMPOSITE_SOURCES:
            monthly = COMPOSITE_SOURCES[s.source](client, year_start, year_end, today)
            monthly = monthly[monthly.index <= pd.Timestamp(month_to)]
        else:
            raise ValueError(f"panel '{panel.id}' series '{s.key}': unknown source '{s.source}'")

        if s.cumulative:
            full_range = pd.date_range(year_start, month_to, freq="MS")
            values = monthly.reindex(full_range, fill_value=0.0).cumsum()
        else:
            values = monthly

        by_month = {d.date(): float(v) for d, v in values.items()}
        data_points = [by_month.get(m) for m in months]
        series_out.append({"key": s.key, "label": s.label, "color": s.color, "data": data_points})
        non_null = [v for v in data_points if v is not None]
        latest[s.key] = non_null[-1] if non_null else 0.0

    return {
        "title": panel.title, "chart_type": panel.chart_type, "unit": panel.unit,
        "currency_symbol": panel.currency_symbol,
        "labels": [calendar.month_name[m.month] for m in months],
        "series": series_out, "latest": latest,
    }


def _build_kpi(client: OdooClient, panel: PanelConfig, today: date) -> dict:
    if panel.source == "crm_new_opportunities_week":
        value = crm_sources.new_opportunities_this_week(client, today)
    else:
        raise ValueError(f"panel '{panel.id}': unknown kpi source '{panel.source}'")
    return {"title": panel.title, "value": value, "caption": panel.caption or panel.title}


def _build_table(client: OdooClient, panel: PanelConfig) -> dict:
    if panel.source == "crm_pipeline_table":
        rows = crm_sources.pipeline_table(client)
    else:
        raise ValueError(f"panel '{panel.id}': unknown table source '{panel.source}'")
    return {
        "title": panel.title,
        "columns": [{"key": c.key, "label": c.label, "type": c.type} for c in panel.columns],
        "rows": rows,
    }


def build_multi_dashboard(cfg: MultiDashboardConfig, today: date | None = None) -> dict:
    client = get_client()
    today = today or date.today()

    panels_out = []
    for p in cfg.panels:
        theme = {**cfg.theme, **p.theme}
        if p.type == "line_chart":
            body = (
                _build_monthly_line_chart(client, p, today)
                if p.granularity == "month"
                else _build_daily_line_chart(p, today)
            )
        elif p.type == "kpi":
            body = _build_kpi(client, p, today)
        elif p.type == "table":
            body = _build_table(client, p)
        else:
            raise ValueError(f"panel '{p.id}': unknown type '{p.type}'")
        panels_out.append({
            "id": p.id, "type": p.type, "theme": theme,
            "col": p.col, "flex": p.flex, **body,
        })

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "name": cfg.name,
        "title": cfg.title,
        "refresh_seconds": cfg.refresh_seconds,
        "panels": panels_out,
    }
