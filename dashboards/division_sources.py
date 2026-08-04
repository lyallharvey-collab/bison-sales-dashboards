"""
Per-division actual-vs-target scalars — the data behind the "thermometer"
meter panel. Brings back the WIG scoreboard Bison ran in Excel until 2023.

Why it exists: the company total hides the story. The 2023 sheet's overall
"72% of target" was Machinery 72%, Consumables 7%, SAS 231% — three completely
different situations averaging into one unremarkable number. The
disaggregation IS the feature.

This is the REFERENCE implementation. lib/divisionSources.js is what production
runs; `npm run livetest` diffs the two on live data. Change a rule here and you
must change it there.
"""

from __future__ import annotations

from datetime import date

import pandas as pd

from .data_sources import read_group_by_team, read_group_totals
from .odoo_client import OdooClient
from .special_sources import PROFORMA_STAGE_ID, subscription_order_names

# The whole business, in three parts. Verified against live Odoo: there are
# exactly three crm.team records, so this is a closed 1:1 mapping.
#
# The other x_studio_*_daily_target columns on x_daily_sales_targets (ARB, BC,
# CC, GBH, PCD, RHB, SRH, Grange) are PER-SALESPERSON, not divisions — and
# their labels disagree with their field names (x_studio_cc_daily_target is
# labelled "CJB", x_studio_gbh_daily_target is "LMJ"), i.e. initials. Ignore
# them here.
DIVISIONS = [
    {"key": "machinery", "label": "Machinery", "team_id": 5,
     "target_field": "x_studio_machinery_daily_target"},
    {"key": "consumables", "label": "Consumables", "team_id": 7,
     "target_field": "x_studio_consumables_daily_target"},
    {"key": "sas", "label": "SAS", "team_id": 6,
     "target_field": "x_studio_sas_daily_target"},
]

# TOTAL's target comes from the company field, NOT the sum of the three, so this
# page and the Sales Graph can never disagree about what the company target is.
# They do agree in Odoo today (30,400 + 7,200 + 4,800 = 42,400); if someone ever
# edits one without the others, TOTAL will visibly stop matching the tubes,
# which is the honest outcome.
COMPANY_TARGET_FIELD = "x_studio_company_daily_target"

# Colour follows the entity: the same blue/green these measures wear as lines on
# the Sales Graph. No new colours, so no palette revalidation.
MEASURES = {
    "orders": {"label": "Orders", "color": "#1e88e5"},
    "invoiced": {"label": "Invoiced", "color": "#43a047"},
}

PERIOD_LABELS = {"day": "daily target", "month": "target to date"}


def meter_bounds(period: str, today: date) -> tuple[date, date]:
    """The date window the meter covers.

    ``day`` — today, except that a weekend rolls BACK to include the prior
    Friday. x_daily_sales_targets has no weekend rows at all (verified:
    2026-08-08/09 simply don't exist), so a Saturday would otherwise divide by
    a zero target while Saturday's orders sat invisible. Rolling back is the
    same fold the charts already apply — see build._fold_weekends_into_prior_business_day.

    ``month`` — month-to-date, compared against the month-to-date target. Never
    against the full-month target: £4.8m against a £10.6m full-year target reads
    as 45% when the honest figure is 77% of pace. Settled precedent here.
    """
    if period == "month":
        return today.replace(day=1), today
    return pd.offsets.BDay().rollback(pd.Timestamp(today)).date(), today


def _subscription_invoices_by_team(
    client: OdooClient, day_from: date, day_to: date
) -> dict[int, float]:
    names = subscription_order_names(client)
    if not names:
        return {}
    return read_group_by_team(
        client,
        "account.move",
        [
            ("invoice_origin", "in", names),
            ("move_type", "in", ["out_invoice", "out_refund"]),
            ("state", "=", "posted"),
        ],
        "invoice_date", "amount_untaxed", day_from, day_to,
    )


def _add(a: dict[int, float], b: dict[int, float]) -> dict[int, float]:
    out = dict(a)
    for k, v in b.items():
        out[k] = out.get(k, 0.0) + v
    return out


def _orders_by_team(client: OdooClient, day_from: date, day_to: date) -> dict[int, float]:
    """The same three ingredients as the company Orders line — confirmed
    orders, proformas, subscription invoicing — but split by team.

    ONE deliberate divergence: sales_orders_component pins the whole month's
    subscription lump onto the month's first day with activity, because the
    original SQL joined one monthly total onto one row. A meter covering a
    single day has no "first day of the month" to pin to, so subscription
    invoices are counted on their real invoice_date instead. Currently ~£2.8k a
    month, all SAS, against a £4.8k/day SAS target — small in total but
    material on the day it lands, so dropping it would understate SAS.
    """
    confirmed = read_group_by_team(
        client, "sale.order", [("state", "=", "sale")],
        "date_order", "amount_untaxed", day_from, day_to,
    )
    proforma = read_group_by_team(
        client, "sale.order",
        [("state", "in", ["draft", "sent"]), ("machinary_stage_id", "=", PROFORMA_STAGE_ID)],
        "date_order", "amount_untaxed", day_from, day_to,
    )
    subscriptions = _subscription_invoices_by_team(client, day_from, day_to)
    return _add(_add(confirmed, proforma), subscriptions)


def _invoiced_by_team(client: OdooClient, day_from: date, day_to: date) -> dict[int, float]:
    """Same domain as the Invoiced series on the Sales Graph."""
    return read_group_by_team(
        client, "bison_core.account_move_gp_report",
        [
            ("move_id.state", "=", "posted"),
            ("move_id.move_type", "in", ["out_invoice", "out_refund"]),
        ],
        "sales_target_date", "aml_total_net", day_from, day_to,
    )


def assemble_meters(
    targets: dict[str, float], actuals_by_team: dict[int, float]
) -> list[dict]:
    """`pct` is None, never 0 or infinity, when the target is zero: "no target
    set" and "0% of target" are different statements and the renderer treats
    them differently."""
    rows = []
    for d in DIVISIONS:
        target = targets.get(d["target_field"]) or 0.0
        actual = actuals_by_team.get(d["team_id"], 0.0)
        rows.append({
            "key": d["key"], "label": d["label"],
            "target": target, "actual": actual,
            "pct": (actual / target) if target else None,
            "is_total": False,
        })

    # TOTAL sums the SOURCE, not the three rows above: a record with no team, or
    # on a fourth team someone adds in Odoo without mapping it here, still
    # counts towards the company figure. A scoreboard whose parts silently fail
    # to add up to the whole is worse than one showing an unattributed remainder.
    actual = sum(actuals_by_team.values())
    target = targets.get(COMPANY_TARGET_FIELD) or 0.0
    rows.append({
        "key": "total", "label": "TOTAL",
        "target": target, "actual": actual,
        "pct": (actual / target) if target else None,
        "is_total": True,
    })
    return rows


def division_meters(
    client: OdooClient,
    today: date,
    period: str = "day",
    measure: str = "orders",
) -> dict:
    if measure not in MEASURES:
        raise ValueError(f"unknown meter measure '{measure}'")
    if period not in ("day", "month"):
        raise ValueError(f"unknown meter period '{period}'")
    day_from, day_to = meter_bounds(period, today)

    # One read_group, four measures — not four read_groups. CPU budget (the JS
    # twin is the one that's charged, but the two must issue the same queries).
    targets = read_group_totals(
        client, "x_daily_sales_targets",
        [
            ("x_studio_date", ">=", day_from.isoformat()),
            ("x_studio_date", "<=", day_to.isoformat()),
        ],
        [d["target_field"] for d in DIVISIONS] + [COMPANY_TARGET_FIELD],
    )
    actuals_by_team = (
        _invoiced_by_team(client, day_from, day_to)
        if measure == "invoiced"
        else _orders_by_team(client, day_from, day_to)
    )

    return {
        "period": period,
        "measure": measure,
        "measure_label": MEASURES[measure]["label"],
        "period_label": PERIOD_LABELS[period],
        "color": MEASURES[measure]["color"],
        "period_from": day_from.isoformat(),
        "period_to": day_to.isoformat(),
        "meters": assemble_meters(targets, actuals_by_team),
    }
