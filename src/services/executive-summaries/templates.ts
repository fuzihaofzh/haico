import { ExecutiveSummaryStatus } from '../../types';

export const EXECUTIVE_SUMMARY_STATUSES = ['draft', 'final', 'archived'] as const;

export interface ExecutiveSummaryBlockTemplate {
  key: string;
  title: string;
  placeholder: string;
}

export const DEFAULT_BLOCK_TEMPLATES: ExecutiveSummaryBlockTemplate[] = [
  {
    key: 'cash_position',
    title: 'Cash Position Overview',
    placeholder: 'Summarize opening/closing balances, net change, and key movements across entities.',
  },
  {
    key: 'payment_activity',
    title: 'Payment Activity',
    placeholder: 'Total payment volume and value, approval turnaround, rejected/escalated items.',
  },
  {
    key: 'liquidity_alerts',
    title: 'Liquidity Alerts',
    placeholder: 'Alerts triggered during the period: threshold breaches, forecast deviations, counterparty issues.',
  },
  {
    key: 'forecast_variance',
    title: 'Forecast vs. Actual Variance',
    placeholder: 'Highlight material variances between forecasted and actual cash flows with root-cause notes.',
  },
  {
    key: 'risk_compliance',
    title: 'Risk & Compliance',
    placeholder: 'FX exposure changes, counterparty limit usage, policy exceptions or audit findings.',
  },
  {
    key: 'action_items',
    title: 'Action Items & Next Steps',
    placeholder: 'Carry-forward items, upcoming maturities, decisions required before next review.',
  },
];

export function isExecutiveSummaryStatus(value: unknown): value is ExecutiveSummaryStatus {
  return (EXECUTIVE_SUMMARY_STATUSES as readonly unknown[]).includes(value);
}
