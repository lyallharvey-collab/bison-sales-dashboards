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

from .data_sources import read_group_daily, read_group_total
from .odoo_client import OdooClient

PROFORMA_STAGE_ID = 2  # x_daily_sales_targets / sale.order "Machinery Stage" = PROFORMA


def _subscription_invoice_total(client: OdooClient, month_start: date, month_end: date) -> float:
    sub_orders = client.search_read(
        "sale.order", [["is_subscription", "=", True]], fields=["name"], limit=10000
    )
    names = [o["name"] for o in sub_orders]
    if not names:
        return 0.0
    return read_group_total(
        client,
        "account.move",
        [
            ("invoice_origin", "in", names),
            ("move_type", "in", ["out_invoice", "out_refund"]),
            ("state", "=", "posted"),
            ("invoice_date", ">=", month_start.isoformat()),
            ("invoice_date", "<=", month_end.isoformat()),
        ],
        "amount_untaxed",
    )


def sales_orders_component(
    client: OdooClient, month_start: date, month_end: date, today: date
) -> pd.Series:
    day_to = min(today, month_end)

    confirmed = read_group_daily(
        client, "sale.order", [("state", "=", "sale")],
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


COMPOSITE_SOURCES = {
    "sales_orders_component": sales_orders_component,
}
