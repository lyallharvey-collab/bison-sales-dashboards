import { addDays, isoDate, isoWeekBounds } from './dates.js';

// Verified live against this Odoo 18 instance: crm.stage ids 1/11/10/12/13
// are New/Qualifying/Discovery/Solution/Final Negotiation, matching the
// Dashboard Ninja export's hardcoded stage_id list and weighted-value
// percentages (0% / 6% / 20% / 50% / 65%) exactly.
const PIPELINE_STAGES = [
  [1, 'New', 0.0],
  [11, 'Qualifying', 0.06],
  [10, 'Discovery', 0.2],
  [12, 'Solution', 0.5],
  [13, 'Final Negotiation', 0.65],
];
const PIPELINE_STAGE_IDS = PIPELINE_STAGES.map((s) => s[0]);

export async function newOpportunitiesThisWeek(client, today) {
  const [monday, sunday] = isoWeekBounds(today);
  return client.searchCount('crm.lead', [
    ['create_date', '>=', isoDate(monday)],
    ['create_date', '<', isoDate(addDays(sunday, 1))],
    ['active', 'in', [true, false]], // include archived leads too
  ]);
}

/** One row per open pipeline stage (count / total value / weighted value),
 * plus a TOTAL row — mirrors crm_sources.py's pipeline_table.
 *
 * Uses read_group, NOT a row pull. Pulling the individual leads meant
 * parsing ~734 records of XML to produce 5 numbers, which on its own was
 * enough to blow the Workers free-tier 10ms CPU budget (observed:
 * outcome "exceededCpu"). read_group has Postgres do the count/sum and
 * returns 5 rows. */
export async function pipelineTable(client) {
  const groups = await client.readGroup(
    'crm.lead',
    [
      ['active', '=', true],
      ['won_status', '=', 'pending'],
      ['stage_id', 'in', PIPELINE_STAGE_IDS],
    ],
    ['expected_revenue'],
    ['stage_id'],
    false,
  );

  const byStage = new Map(PIPELINE_STAGE_IDS.map((id) => [id, { count: 0, value: 0 }]));
  for (const g of groups) {
    const sid = Array.isArray(g.stage_id) ? g.stage_id[0] : g.stage_id;
    if (!byStage.has(sid)) continue;
    byStage.set(sid, {
      // Odoo names the count key after the groupby field; __count is the
      // documented fallback. Both are checked so a version change can't
      // silently zero the counts.
      count: g.stage_id_count ?? g.__count ?? 0,
      value: g.expected_revenue || 0,
    });
  }

  const out = [];
  const total = { count: 0, value: 0, weighted: 0 };
  for (const [sid, name, pct] of PIPELINE_STAGES) {
    const { count, value } = byStage.get(sid);
    const weighted = value * pct;
    out.push({ stage: name, total_opps: count, total_value: value, weighted_value: weighted });
    total.count += count;
    total.value += value;
    total.weighted += weighted;
  }
  out.push({ stage: 'TOTAL', total_opps: total.count, total_value: total.value, weighted_value: total.weighted });
  return out;
}

export const KPI_SOURCES = { crm_new_opportunities_week: newOpportunitiesThisWeek };
export const TABLE_SOURCES = { crm_pipeline_table: pipelineTable };
