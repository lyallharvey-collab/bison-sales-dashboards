"""Generic per-day aggregation over an Odoo model via read_group."""

from __future__ import annotations

from datetime import date

import pandas as pd

from .odoo_client import OdooClient


def read_group_daily(
    client: OdooClient,
    model: str,
    domain: list,
    date_field: str,
    measure: str,
    day_from: date,
    day_to: date,
) -> pd.Series:
    """Sum `measure` per calendar day of `date_field`, for date_field in
    [day_from, day_to] inclusive, aggregated server-side.

    Returns a pandas Series indexed by pandas Timestamp (midnight, one per day
    that actually has a non-zero group — missing days are simply absent, the
    caller reindexes/fills).
    """
    full_domain = [
        *domain,
        (date_field, ">=", day_from.isoformat()),
        (date_field, "<=", day_to.isoformat()),
    ]
    groups = client.read_group(
        model, full_domain, [measure], [f"{date_field}:day"], lazy=False
    )

    dates, values = [], []
    for g in groups:
        rng = (g.get("__range") or {}).get(f"{date_field}:day")
        if not rng or not rng.get("from"):
            continue  # empty bucket Odoo sometimes includes when lazy=False
        day = pd.Timestamp(rng["from"][:10])
        dates.append(day)
        values.append(g.get(measure) or 0.0)

    return pd.Series(values, index=pd.DatetimeIndex(dates)).sort_index()


def read_group_monthly(
    client: OdooClient,
    model: str,
    domain: list,
    date_field: str,
    measure: str,
    month_from: date,
    month_to: date,
) -> pd.Series:
    """Sum `measure` per calendar month of `date_field`, for date_field in
    [month_from, month_to] inclusive. Same __range-based approach as
    read_group_daily, just grouped at ":month" granularity — returns a Series
    indexed by the first day of each month that has data.
    """
    full_domain = [
        *domain,
        (date_field, ">=", month_from.isoformat()),
        (date_field, "<=", month_to.isoformat()),
    ]
    groups = client.read_group(
        model, full_domain, [measure], [f"{date_field}:month"], lazy=False
    )

    months, values = [], []
    for g in groups:
        rng = (g.get("__range") or {}).get(f"{date_field}:month")
        if not rng or not rng.get("from"):
            continue
        months.append(pd.Timestamp(rng["from"][:10]))
        values.append(g.get(measure) or 0.0)

    return pd.Series(values, index=pd.DatetimeIndex(months)).sort_index()


def read_group_total(
    client: OdooClient,
    model: str,
    domain: list,
    measure: str,
) -> float:
    """A single server-side sum, no groupby — for one-off scalars."""
    groups = client.read_group(model, domain, [measure], [], lazy=False)
    if not groups:
        return 0.0
    return float(groups[0].get(measure) or 0.0)


def search_count(client: OdooClient, model: str, domain: list) -> int:
    """A single server-side count — for KPI tiles."""
    return client.execute(model, "search_count", domain or [])
