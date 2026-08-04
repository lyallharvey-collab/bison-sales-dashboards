/**
 * Ported from ../config/*.yaml (sales_graph, sales_dashboard, division_meters).
 *
 * KNOWN TRADEOFF: this duplicates those YAML files rather than parsing them
 * at runtime (would need a YAML parser bundled into the Worker for little
 * benefit, since these rarely change). If you edit the YAML config for a
 * series/panel, mirror the change here too — nothing enforces they stay in
 * sync.
 */

const SALES_GRAPH_SERIES = [
  {
    key: 'target', label: 'Target', color: '#8e24aa',
    source: 'read_group', model: 'x_daily_sales_targets', domain: [],
    dateField: 'x_studio_date', measure: 'x_studio_company_daily_target',
    cumulative: true, extend: true,
  },
  {
    key: 'breakeven', label: 'Breakeven', color: '#f4511e',
    source: 'read_group', model: 'x_daily_sales_targets', domain: [],
    dateField: 'x_studio_date', measure: 'x_studio_company_daily_breakeven',
    cumulative: true, extend: true,
  },
  {
    key: 'orders', label: 'Orders', color: '#1e88e5',
    source: 'sales_orders_component', cumulative: true, extend: false,
  },
  {
    key: 'invoiced', label: 'Invoiced', color: '#43a047',
    source: 'read_group', model: 'bison_core.account_move_gp_report',
    domain: [['move_id.state', '=', 'posted'], ['move_id.move_type', 'in', ['out_invoice', 'out_refund']]],
    dateField: 'sales_target_date', measure: 'aml_total_net',
    cumulative: true, extend: false,
  },
];

export const SALES_GRAPH_CONFIG = {
  name: 'sales_graph',
  title: 'Sales Graph — This Month',
  chartType: 'line',
  unit: 'currency',
  currencySymbol: '£',
  refreshSeconds: 120,
  logoUrl: null,
  theme: {
    background: '#ffffff',
    font_color: '#111111',
    header_bg: '#111111',
    header_font_color: '#ffffff',
    font_family: "'Segoe UI', Arial, sans-serif",
    card_bg: 'rgba(17,17,17,0.05)',
  },
  series: SALES_GRAPH_SERIES,
};

export const SALES_DASHBOARD_CONFIG = {
  name: 'sales_dashboard',
  title: 'Sales Dashboard',
  refreshSeconds: 120,
  theme: {},
  panels: [
    {
      id: 'sales_graph', type: 'line_chart', title: 'Sales Graph', col: 'left', flex: 1,
      granularity: 'day', chartType: 'line', unit: 'currency', currencySymbol: '£',
      theme: { background: '#ffffff', font_color: '#111111' },
      series: SALES_GRAPH_SERIES,
    },
    {
      id: 'year_to_date', type: 'line_chart', title: 'Year To Date', col: 'left', flex: 1,
      granularity: 'month', chartType: 'line', unit: 'currency', currencySymbol: '£',
      theme: { background: '#ffffff', font_color: '#111111' },
      series: [
        {
          key: 'target', label: 'Target', color: '#8e24aa',
          source: 'read_group', model: 'x_daily_sales_targets', domain: [],
          dateField: 'x_studio_date', measure: 'x_studio_company_daily_target',
          cumulative: true, extend: true,
        },
        {
          key: 'orders', label: 'Orders', color: '#1e88e5',
          source: 'orders_ytd_monthly_component', cumulative: true, extend: false,
        },
      ],
    },
    {
      id: 'new_opportunities_kpi', type: 'kpi', title: 'New Opportunities this week', col: 'right', flex: 3,
      theme: { background: '#337ab7', font_color: '#ffffff' },
      source: 'crm_new_opportunities_week', caption: 'New Opportunities this week',
    },
    {
      id: 'opportunities_table', type: 'table', title: 'New Opportunities This Week', col: 'right', flex: 6,
      theme: { background: '#ffffff', font_color: '#111111' },
      source: 'crm_pipeline_table',
      columns: [
        { key: 'stage', label: 'Stage', type: 'text' },
        { key: 'total_opps', label: 'Total Opps', type: 'number' },
        { key: 'total_value', label: 'Total Value', type: 'currency' },
        { key: 'weighted_value', label: 'Weighted Value', type: 'currency' },
      ],
    },
  ],
};

/**
 * The per-division WIG scoreboard, on its own page so it can join a rotation of
 * screens later. One panel, four tubes: Machinery / Consumables / SAS / TOTAL.
 *
 * `period: day` and `measure: orders` are the two knobs. `period: month` swaps
 * to month-to-date vs the month-to-date target; `measure: invoiced` swaps the
 * actual. Both paths are implemented — see lib/divisionSources.js.
 */
export const DIVISION_METERS_CONFIG = {
  name: 'division_meters',
  title: 'Divisions — Today',
  refreshSeconds: 120,
  theme: {},
  panels: [
    {
      id: 'division_meters', type: 'meter_group', title: 'Orders vs Daily Target',
      col: 'left', flex: 1, unit: 'currency', currencySymbol: '£',
      period: 'day', measure: 'orders',
      theme: { background: '#ffffff', font_color: '#111111' },
    },
  ],
};
