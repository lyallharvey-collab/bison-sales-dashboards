"""
Composite data sources that don't fit the plain "one model, one measure,
groupby date" shape and so can't be expressed directly in a dashboard YAML.
Registered by name in COMPOSITE_SOURCES and referenced from config via
`source: <name>`.

sales_orders_component mirrors the Dashboard Ninja "Orders" line, which is
itself the sum of three components before the running total is taken:
  - confirmed sale orders (state = 'sale'), by date_order
  - proforma sale orders (state in draft/sent, Machinery Stage = PROFORMA), by date_order
  - subscription/service-contract invoicing for the month, applied as a single
    lump sum on the first day of the month (matches the original SQL, which
    computes one monthly total and joins it onto one row)
"""

from __future__ import annotations

from datetime import date

import pandas as pd

from .data_sources import read_group_daily, read_group_monthly, read_group_total
from .odoo_client import OdooClient

# Both public because division_sources.py builds the SAME "Orders" measure
# split by team, and the two definitions drifting apart would be invisible on
# screen.
PROFORMA_STAGE_ID = 2  # x_daily_sales_targets / sale.order "Machinery Stage" = PROFORMA

# The service-contract plans that count toward the sales target.
# 1 = "Upgraded Service Contract" (monthly), 2 = "Upgraded Annual Contract".
# These are the only two sale.subscription.plan records that exist, so today this
# is equivalent to "has a plan" — but it is written as an explicit list because
# the reference SQL says `plan_id in (1,2)`, and a THIRD plan added in Odoo would
# be silently excluded by both. `npm run sqlcheck` fails if a plan outside this
# list appears, so that drift is loud rather than silent.
CONTRACT_PLAN_IDS = [1, 2]

# A sale order that IS a contract on one of those plans, or a child order of one
# (a renewal keeps subscription_id pointing at its parent). Mirrors the SQL's
# `so.plan_id in (1,2) OR EXISTS (parent pp WHERE pp.plan_id in (1,2))`.
CONTRACT_ORDER_DOMAIN = [
    "|",
    ("plan_id", "in", CONTRACT_PLAN_IDS),
    ("subscription_id.plan_id", "in", CONTRACT_PLAN_IDS),
]

# Excluded from the confirmed-orders leg so a contract is not counted twice.
NOT_A_CONTRACT_ORDER = [("plan_id", "=", False), ("subscription_id", "=", False)]


def subscription_order_names(client: OdooClient) -> list[str]:
    sub_orders = client.search_read(
        "sale.order", list(CONTRACT_ORDER_DOMAIN), fields=["name"], limit=10000
    )
    return [o["name"] for o in sub_orders]


def _subscription_invoice_domain(names: list[str], start: date, end: date) -> list:
    return [
        ("invoice_origin", "in", names),
        ("move_type", "in", ["out_invoice", "out_refund"]),
        ("state", "=", "posted"),
        ("invoice_date", ">=", start.isoformat()),
        ("invoice_date", "<=", end.isoformat()),
    ]


def _net_invoices_minus_refunds(groups: list[dict]) -> float:
    """Credit notes carry a POSITIVE amount_untaxed in Odoo, so they must be
    subtracted, not summed. The original Dashboard Ninja SQL did
    `case when move_type = 'out_invoice' then amount_untaxed else 0-amount_untaxed end`;
    summing both inflated Orders by twice any refund."""
    net = 0.0
    for g in groups:
        move_type = g.get("move_type")
        if isinstance(move_type, (list, tuple)):
            move_type = move_type[0]
        amount = g.get("amount_untaxed") or 0.0
        net += -amount if move_type == "out_refund" else amount
    return net


def _subscription_invoice_total(client: OdooClient, month_start: date, month_end: date) -> float:
    names = subscription_order_names(client)
    if not names:
        return 0.0
    groups = client.read_group(
        "account.move",
        _subscription_invoice_domain(names, month_start, month_end),
        ["amount_untaxed"], ["move_type"], lazy=False,
    )
    return _net_invoices_minus_refunds(groups)


def _subscription_net_by_month(
    client: OdooClient, names: list[str], start: date, end: date
) -> "pd.Series":
    """Per-month net subscription invoicing. One call, grouped by month AND
    move_type, then netted per month."""
    groups = client.read_group(
        "account.move",
        _subscription_invoice_domain(names, start, end),
        ["amount_untaxed"], ["invoice_date:month", "move_type"], lazy=False,
    )
    per_month: dict = {}
    for g in groups:
        rng = (g.get("__range") or {}).get("invoice_date:month")
        if not rng or not rng.get("from"):
            continue
        key = pd.Timestamp(rng["from"][:10])
        move_type = g.get("move_type")
        if isinstance(move_type, (list, tuple)):
            move_type = move_type[0]
        amount = g.get("amount_untaxed") or 0.0
        per_month[key] = per_month.get(key, 0.0) + (-amount if move_type == "out_refund" else amount)
    if not per_month:
        return pd.Series(dtype="float64")
    return pd.Series(per_month).sort_index()


def sales_orders_component(
    client: OdooClient, month_start: date, month_end: date, today: date
) -> pd.Series:
    day_to = min(today, month_end)

    # Contract orders are EXCLUDED here. They would otherwise be counted twice —
    # once when the contract is confirmed and again when it invoices — which was
    # worth GBP6,215.30 in August 2026 alone. The proforma leg below is
    # deliberately NOT filtered the same way: the reference SQL applies the
    # exclusion only to confirmed orders.
    confirmed = read_group_daily(
        client, "sale.order", [("state", "=", "sale"), *NOT_A_CONTRACT_ORDER],
        "date_order", "amount_untaxed", month_start, day_to,
    )
    proforma = read_group_daily(
        client,
        "sale.order",
        [("state", "in", ["draft", "sent"]), ("machinary_stage_id", "=", PROFORMA_STAGE_ID)],
        "date_order", "amount_untaxed", month_start, day_to,
    )
    combined = confirmed.add(proforma, fill_value=0.0)

    sub_total = _subscription_invoice_total(client, month_start, month_end)
    if sub_total:
        first_day = combined.index.min() if not combined.empty else pd.Timestamp(month_start)
        combined.loc[first_day] = combined.get(first_day, 0.0) + sub_total
        combined = combined.sort_index()

    return combined


def orders_ytd_monthly_component(
    client: OdooClient, year_start: date, year_end: date, today: date
) -> pd.Series:
    """Monthly analogue of sales_orders_component, for the "Year To Date"
    chart. Same three ingredients, but the subscription/service-contract
    invoicing is summed PER MONTH (it recurs every month) rather than once —
    matching the export's separate monthly-vs-daily SQL for these two charts.
    """
    month_to = min(today, year_end)

    # Contract orders excluded here too — same double-count as the daily case.
    confirmed = read_group_monthly(
        client, "sale.order", [("state", "=", "sale"), *NOT_A_CONTRACT_ORDER],
        "date_order", "amount_untaxed", year_start, month_to,
    )
    proforma = read_group_monthly(
        client,
        "sale.order",
        [("state", "in", ["draft", "sent"]), ("machinary_stage_id", "=", PROFORMA_STAGE_ID)],
        "date_order", "amount_untaxed", year_start, month_to,
    )
    combined = confirmed.add(proforma, fill_value=0.0)

    names = subscription_order_names(client)
    if names:
        # Netted per month, not summed — see _net_invoices_minus_refunds.
        sub_monthly = _subscription_net_by_month(client, names, year_start, month_to)
        combined = combined.add(sub_monthly, fill_value=0.0)

    return combined.sort_index()


COMPOSITE_SOURCES = {
    "sales_orders_component": sales_orders_component,
    "orders_ytd_monthly_component": orders_ytd_monthly_component,
}
