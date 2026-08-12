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


def read_group_totals(
    client: OdooClient,
    model: str,
    domain: list,
    measures: list[str],
) -> dict[str, float]:
    """SEVERAL server-side sums in ONE call, no groupby.

    Deliberately not a loop over read_group_total: the JS twin is charged CPU
    per response parsed, so N measures off one model with one domain must be
    one call there — and the two implementations have to match.
    """
    groups = client.read_group(model, domain, measures, [], lazy=False)
    first = groups[0] if groups else {}
    return {m: float(first.get(m) or 0.0) for m in measures}


def read_group_net_by_team(
    client: OdooClient,
    model: str,
    domain: list,
    date_field: str,
    measure: str,
    day_from: date,
    day_to: date,
) -> dict[int, float]:
    """Like read_group_by_team, but NETS credit notes instead of adding them:
    groups by team_id AND move_type and subtracts ``out_refund``.

    Needed because credit notes carry a POSITIVE amount_untaxed in Odoo. The
    company Orders line has netted them since Aug 2026; the per-division split
    did not, and summed them, so the division board over-read by twice every
    refund — GBP834.00 on a single GBP417.00 credit note, which is how it was
    caught (the divisions stopped summing to the company line). Same bug, second
    location: any per-team money coming off account.move must use this.
    """
    full_domain = [
        *domain,
        (date_field, ">=", day_from.isoformat()),
        (date_field, "<=", day_to.isoformat()),
    ]
    groups = client.read_group(
        model, full_domain, [measure], ["team_id", "move_type"], lazy=False
    )

    out: dict[int, float] = {}
    for g in groups:
        team = g.get("team_id")
        team_id = team[0] if isinstance(team, (list, tuple)) and team else 0
        move_type = g.get("move_type")
        if isinstance(move_type, (list, tuple)):
            move_type = move_type[0]
        amount = float(g.get(measure) or 0.0)
        out[team_id] = out.get(team_id, 0.0) + (-amount if move_type == "out_refund" else amount)
    return out


def read_group_by_team(
    client: OdooClient,
    model: str,
    domain: list,
    date_field: str,
    measure: str,
    day_from: date,
    day_to: date,
) -> dict[int, float]:
    """Sum `measure` per sales team (`team_id`), for date_field in
    [day_from, day_to] inclusive.

    Records with no team land under key 0 rather than being dropped — a
    division scoreboard whose parts don't add up to the whole is worse than one
    that shows an unattributed remainder.
    """
    full_domain = [
        *domain,
        (date_field, ">=", day_from.isoformat()),
        (date_field, "<=", day_to.isoformat()),
    ]
    groups = client.read_group(model, full_domain, [measure], ["team_id"], lazy=False)

    out: dict[int, float] = {}
    for g in groups:
        team = g.get("team_id")
        # read_group returns a many2one as [id, display_name], or False when unset.
        team_id = team[0] if isinstance(team, (list, tuple)) and team else 0
        out[team_id] = out.get(team_id, 0.0) + float(g.get(measure) or 0.0)
    return out


def search_count(client: OdooClient, model: str, domain: list) -> int:
    """A single server-side count — for KPI tiles."""
    return client.execute(model, "search_count", domain or [])
