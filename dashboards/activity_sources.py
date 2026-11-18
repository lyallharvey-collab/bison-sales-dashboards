"""
Completed sales activities per rep, scored in points — the data behind the
/activities/ page's split bars.

Brings back the per-rep activity tracker Simon kept in Excel until Odoo went
live (Dec 2023). Scoring (Lyall's rule, the same one used to backfill that
spreadsheet from Odoo in ../activity-tracker/):

  call, in or out, contacted or not   1
  visit (Appointment / Site Demo):    1 if not contacted, 5 if contacted
  showroom visit                      5

A visit logged without the Contacted Call tick scores 1 even for reps who
rarely use the tick (Roddy). That was decided, not overlooked.

This is the REFERENCE implementation. lib/activitySources.js is what production
runs; `npm run livetest` diffs the two on live data. Change a rule here and you
must change it there.
"""

from __future__ import annotations

from datetime import date, timedelta

from .odoo_client import OdooClient

# res.partner ids of the reps — the author_id on a done-activity message is the
# user's partner. Verified against live Odoo on 18 Nov 2026. Jonathan Robins
# (the old J column) is deliberately left off for now.
REPS = [
    {"key": "angus", "name": "Angus Bushnell", "partner_id": 132062},
    {"key": "braden", "name": "Braden Carvell", "partner_id": 132063},
    {"key": "roddy", "name": "Roddy Bushnell", "partner_id": 132068},
    {"key": "simon", "name": "Simon Harvey", "partner_id": 132070},
    {"key": "billy", "name": "Billy Hodgkinson", "partner_id": 134942},
    {"key": "laurie", "name": "Laurie Jackson", "partner_id": 132751},
]

# mail.activity.type ids. Online Meeting, Email and Action are not counted.
CALL_OUT, CALL_IN, APPOINTMENT, SITE_DEMO, SHOWROOM = 17, 2, 3, 32, 18
ACTIVITY_TYPE_IDS = [CALL_OUT, CALL_IN, APPOINTMENT, SITE_DEMO, SHOWROOM]

# Drawn in this order. See lib/activitySources.js for the colour reasoning.
CATEGORIES = [
    {"key": "calls_out", "label": "Calls out", "points": 1, "color": "#2f5d8a", "ink": "#ffffff"},
    {"key": "calls_in", "label": "Calls in", "points": 1, "color": "#9cbbdc", "ink": "#14304d"},
    {"key": "visits_contacted", "label": "Visits, contacted", "points": 5, "color": "#a6520b", "ink": "#ffffff"},
    {"key": "visits_not_contacted", "label": "Visits, not contacted", "points": 1, "color": "#f2c38f", "ink": "#5a2e05"},
    {"key": "showroom", "label": "Showroom", "points": 5, "color": "#1f7a70", "ink": "#ffffff"},
]

PERIODS = [
    {"key": "week", "label": "This week"},
    {"key": "last_week", "label": "Last week"},
    {"key": "month", "label": "This month"},
    {"key": "ytd", "label": "Year to date"},
]


def category_of(type_id: int | None, contacted: bool) -> str | None:
    if type_id == CALL_OUT:
        return "calls_out"
    if type_id == CALL_IN:
        return "calls_in"
    if type_id in (APPOINTMENT, SITE_DEMO):
        return "visits_contacted" if contacted else "visits_not_contacted"
    if type_id == SHOWROOM:
        return "showroom"
    return None


def period_bounds(key: str, today: date) -> tuple[date, date]:
    """Inclusive calendar-date bounds; "last week" is the whole previous Mon–Sun."""
    monday = today - timedelta(days=today.weekday())
    if key == "week":
        return monday, today
    if key == "last_week":
        return monday - timedelta(days=7), monday - timedelta(days=1)
    if key == "month":
        return today.replace(day=1), today
    if key == "ytd":
        return today.replace(month=1, day=1), today
    raise ValueError(f"unknown activity period '{key}'")


def period_domain(day_from: date, day_to: date) -> list:
    # mail.message.date is a UTC datetime: midnight on the first day up to, not
    # including, midnight after the last.
    return [
        ["mail_activity_type_id", "in", ACTIVITY_TYPE_IDS],
        ["author_id", "in", [r["partner_id"] for r in REPS]],
        ["date", ">=", f"{day_from.isoformat()} 00:00:00"],
        ["date", "<", f"{(day_to + timedelta(days=1)).isoformat()} 00:00:00"],
    ]


def _m2o_id(v):
    return v[0] if isinstance(v, (list, tuple)) else (v or None)


def assemble_activity(groups: list[dict]) -> dict:
    by_partner = {r["partner_id"]: r for r in REPS}
    counts = {r["key"]: {c["key"]: 0 for c in CATEGORIES} for r in REPS}
    for g in groups:
        rep = by_partner.get(_m2o_id(g.get("author_id")))
        cat = category_of(_m2o_id(g.get("mail_activity_type_id")), bool(g.get("contacted_call")))
        if rep and cat:
            counts[rep["key"]][cat] += g.get("__count", 0)

    def points(c):
        return sum(c[k["key"]] * k["points"] for k in CATEGORIES)

    def activities(c):
        return sum(c[k["key"]] for k in CATEGORIES)

    reps = [
        {"key": r["key"], "name": r["name"], "counts": counts[r["key"]],
         "points": points(counts[r["key"]]), "activities": activities(counts[r["key"]])}
        for r in REPS
    ]
    totals = {k["key"]: sum(r["counts"][k["key"]] for r in reps) for k in CATEGORIES}
    return {"reps": reps, "totals": totals, "points": points(totals), "activities": activities(totals)}


def activity_for_period(client: OdooClient, key: str, today: date) -> dict:
    day_from, day_to = period_bounds(key, today)
    groups = client.read_group(
        "mail.message", period_domain(day_from, day_to), [],
        ["author_id", "mail_activity_type_id", "contacted_call"], lazy=False,
    )
    label = next(p["label"] for p in PERIODS if p["key"] == key)
    return {"key": key, "label": label, "from": day_from.isoformat(), "to": day_to.isoformat(),
            **assemble_activity(groups)}


def rep_activity(client: OdooClient, today: date) -> list[dict]:
    return [activity_for_period(client, p["key"], today) for p in PERIODS]
