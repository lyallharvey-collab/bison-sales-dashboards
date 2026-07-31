"""
CRM-specific data sources for the "New Opportunities" KPI and pipeline table.

Verified live against this Odoo 18 instance: crm.stage ids 1/11/10/12/13 are
New/Qualifying/Discovery/Solution/Final Negotiation, matching the Dashboard
Ninja export's hardcoded stage_id list and its weighted-value percentages
(0% / 6% / 20% / 50% / 65%) exactly.
"""

from __future__ import annotations

from datetime import date, timedelta

from .data_sources import search_count
from .odoo_client import OdooClient

PIPELINE_STAGES = [
    (1, "New", 0.00),
    (11, "Qualifying", 0.06),
    (10, "Discovery", 0.20),
    (12, "Solution", 0.50),
    (13, "Final Negotiation", 0.65),
]
PIPELINE_STAGE_IDS = [s[0] for s in PIPELINE_STAGES]


def _iso_week_bounds(today: date) -> tuple[date, date]:
    monday = today - timedelta(days=today.weekday())
    return monday, monday + timedelta(days=6)


def new_opportunities_this_week(client: OdooClient, today: date | None = None) -> int:
    today = today or date.today()
    monday, sunday = _iso_week_bounds(today)
    return search_count(
        client,
        "crm.lead",
        [
            ("create_date", ">=", monday.isoformat()),
            ("create_date", "<", (sunday + timedelta(days=1)).isoformat()),
            ("active", "in", [True, False]),  # export includes archived leads too
        ],
    )


def pipeline_table(client: OdooClient) -> list[dict]:
    """One row per open pipeline stage (count / total value / weighted value),
    plus a TOTAL row — mirrors the export's two-part UNION query.

    Uses read_group rather than pulling the individual leads: ~734 rows to
    produce 5 numbers. Kept identical to the Worker's JS implementation
    (worker/src/crmSources.js), where the row pull was expensive enough to
    exceed the Cloudflare free-tier CPU budget.
    """
    groups = client.read_group(
        "crm.lead",
        [
            ("active", "=", True),
            ("won_status", "=", "pending"),
            ("stage_id", "in", PIPELINE_STAGE_IDS),
        ],
        ["expected_revenue"],
        ["stage_id"],
        lazy=False,
    )

    by_stage = {sid: {"count": 0, "value": 0.0} for sid in PIPELINE_STAGE_IDS}
    for g in groups:
        stage = g.get("stage_id")
        sid = stage[0] if isinstance(stage, (list, tuple)) else stage
        if sid not in by_stage:
            continue
        by_stage[sid]["count"] = g.get("stage_id_count") or g.get("__count") or 0
        by_stage[sid]["value"] = g.get("expected_revenue") or 0.0

    out = []
    total = {"count": 0, "value": 0.0, "weighted": 0.0}
    for sid, name, pct in PIPELINE_STAGES:
        count = by_stage[sid]["count"]
        value = by_stage[sid]["value"]
        weighted = value * pct
        out.append({
            "stage": name, "total_opps": count,
            "total_value": value, "weighted_value": weighted,
        })
        total["count"] += count
        total["value"] += value
        total["weighted"] += weighted

    out.append({
        "stage": "TOTAL", "total_opps": total["count"],
        "total_value": total["value"], "weighted_value": total["weighted"],
    })
    return out
