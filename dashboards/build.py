"""Turn a DashboardConfig into the JSON payload the template/browser consume."""

from __future__ import annotations

import calendar
from datetime import date, datetime, timezone

import pandas as pd

from .config_schema import DashboardConfig, SeriesConfig
from .data_sources import read_group_daily
from .odoo_client import OdooClient, get_client
from .special_sources import COMPOSITE_SOURCES


def _month_bounds(today: date) -> tuple[date, date]:
    month_start = today.replace(day=1)
    last_day = calendar.monthrange(today.year, today.month)[1]
    month_end = today.replace(day=last_day)
    return month_start, month_end


def _fold_weekends_into_prior_business_day(daily: pd.Series) -> pd.Series:
    """The chart's x-axis is business days only. Weekend activity has no day
    of its own to land on, so fold it into the same week's Friday — backward,
    not forward into next Monday, so it shows up immediately (as part of
    Friday's running total) rather than sitting invisible until Monday
    arrives, including when "today" is itself a Saturday/Sunday."""
    if daily.empty:
        return daily
    out: dict = {}
    for ts, val in daily.items():
        if ts.weekday() >= 5:  # Saturday=5, Sunday=6
            ts = pd.offsets.BDay().rollback(ts)
        out[ts] = out.get(ts, 0.0) + val
    return pd.Series(out).sort_index()


def _daily_for_series(
    client: OdooClient, s: SeriesConfig, month_start: date, month_end: date, today: date, day_to: date
) -> pd.Series:
    if s.source == "read_group":
        if not (s.model and s.date_field and s.measure):
            raise ValueError(f"series '{s.key}': read_group source needs model/date_field/measure")
        daily = read_group_daily(client, s.model, s.domain, s.date_field, s.measure, month_start, day_to)
    elif s.source in COMPOSITE_SOURCES:
        daily = COMPOSITE_SOURCES[s.source](client, month_start, month_end, today)
        daily = daily[daily.index <= pd.Timestamp(day_to)]
    else:
        raise ValueError(f"series '{s.key}': unknown source '{s.source}'")
    return _fold_weekends_into_prior_business_day(daily)


def build_dashboard(cfg: DashboardConfig, today: date | None = None) -> dict:
    client = get_client()
    today = today or date.today()
    month_start, month_end = _month_bounds(today)
    x_axis = [ts.date() for ts in pd.bdate_range(month_start, month_end)]

    series_out = []
    latest = {}
    for s in cfg.series:
        day_to = month_end if s.extend_to_month_end else min(today, month_end)
        daily = _daily_for_series(client, s, month_start, month_end, today, day_to)

        if s.cumulative:
            full_range = pd.bdate_range(month_start, day_to)
            series_values = daily.reindex(full_range, fill_value=0.0).cumsum()
        else:
            series_values = daily

        by_date = {d.date().isoformat(): float(v) for d, v in series_values.items()}
        data_points = [by_date.get(d.isoformat()) for d in x_axis]
        series_out.append({
            "key": s.key,
            "label": s.label,
            "color": s.color,
            "data": data_points,
        })
        non_null = [v for v in data_points if v is not None]
        latest[s.key] = non_null[-1] if non_null else 0.0

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "name": cfg.name,
        "title": cfg.title,
        "chart_type": cfg.chart_type,
        "unit": cfg.unit,
        "currency_symbol": cfg.currency_symbol,
        "theme": cfg.theme,
        "logo_url": cfg.logo_url,
        "refresh_seconds": cfg.refresh_seconds,
        "labels": [d.isoformat() for d in x_axis],
        "series": series_out,
        "latest": latest,
    }
