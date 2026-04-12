import Database from 'better-sqlite3';
import { FastifyInstance } from 'fastify';
import {
  EscalationInboxItem,
  EscalationInboxSummary,
  Site,
  VisitPreparationSummary,
} from '../models/types';
import { AEEscalationService } from '../services/ae-escalation';
import { VisitSummaryService } from '../services/visit-summaries';

type OperationsQuery = {
  site_id?: string;
  from?: string;
  to?: string;
  escalated_to?: string;
  priority?: 'standard' | 'urgent' | 'critical';
  acknowledged?: 'true' | 'false';
};

type OperationsPageModel = {
  generatedAt: string;
  selectedSiteId: string;
  selectedRecipient: string;
  priorityFilter: string;
  acknowledgedFilter: string;
  sites: Site[];
  recipients: string[];
  visits: VisitPreparationSummary[];
  inbox: EscalationInboxSummary;
  dateRange: { from: string; to: string };
};

export function registerUIRoutes(
  app: FastifyInstance,
  db: Database.Database,
  visitService: VisitSummaryService,
  escalationService: AEEscalationService,
) {
  app.get('/', (_req, reply) => {
    reply.redirect('/operations');
  });

  app.get<{ Querystring: OperationsQuery }>('/operations', (req, reply) => {
    const sites = db
      .prepare(`SELECT * FROM sites ORDER BY name ASC`)
      .all() as Site[];
    const recipients = db
      .prepare(
        `SELECT DISTINCT escalated_to FROM ae_escalations ORDER BY escalated_to ASC`,
      )
      .pluck()
      .all() as string[];

    const today = currentDate();
    const selectedSiteId =
      req.query.site_id && sites.some((site) => site.id === req.query.site_id)
        ? req.query.site_id
        : sites[0]?.id ?? '';
    const fromDate = isIsoDate(req.query.from) ? req.query.from : today;
    const toDate = isIsoDate(req.query.to)
      ? req.query.to
      : addDays(today, 7);
    const selectedRecipient =
      req.query.escalated_to && recipients.includes(req.query.escalated_to)
        ? req.query.escalated_to
        : '';
    const priorityFilter = req.query.priority ?? '';
    const acknowledgedFilter = req.query.acknowledged ?? '';

    const visits = selectedSiteId
      ? visitService.getUpcomingSummaries(selectedSiteId, fromDate, toDate)
      : [];
    const inbox = escalationService.getInbox({
      siteId: selectedSiteId || undefined,
      escalatedTo: selectedRecipient || undefined,
      priority: priorityFilter || undefined,
      acknowledged:
        acknowledgedFilter === 'true'
          ? true
          : acknowledgedFilter === 'false'
            ? false
            : undefined,
    });

    const pageModel: OperationsPageModel = {
      generatedAt: new Date().toISOString(),
      selectedSiteId,
      selectedRecipient,
      priorityFilter,
      acknowledgedFilter,
      sites,
      recipients,
      visits,
      inbox,
      dateRange: { from: fromDate, to: toDate },
    };

    reply.type('text/html; charset=utf-8').send(renderPage(pageModel));
  });
}

function renderPage(model: OperationsPageModel): string {
  const selectedSite =
    model.sites.find((site) => site.id === model.selectedSiteId) ?? null;
  const totalPrepMinutes = model.visits.reduce(
    (sum, summary) => sum + summary.total_estimated_minutes,
    0,
  );
  const requiredChecklistCount = model.visits.reduce(
    (sum, summary) =>
      sum + summary.preparation_checklist.filter((item) => item.required).length,
    0,
  );
  const visitAlertCount = model.visits.reduce(
    (sum, summary) => sum + summary.alerts.length,
    0,
  );
  const screeningParticipants = model.visits.filter(
    (summary) => summary.participant.status === 'screening',
  ).length;
  const safeState = jsonForScript({
    currentUrl: operationsQueryHref({
      site_id: model.selectedSiteId,
      from: model.dateRange.from,
      to: model.dateRange.to,
      escalated_to: model.selectedRecipient,
      priority: model.priorityFilter,
      acknowledged: model.acknowledgedFilter,
    }),
  });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Beacon Clinical Operations</title>
    <style>
      :root {
        --bg: #f3efe6;
        --panel: rgba(255, 252, 246, 0.92);
        --panel-strong: rgba(255, 255, 255, 0.98);
        --ink: #132539;
        --muted: #5f6b7a;
        --line: rgba(19, 37, 57, 0.12);
        --accent: #146c63;
        --accent-soft: rgba(20, 108, 99, 0.12);
        --critical: #a23032;
        --critical-soft: rgba(162, 48, 50, 0.14);
        --urgent: #a65c00;
        --urgent-soft: rgba(166, 92, 0, 0.14);
        --standard: #2e5b9a;
        --standard-soft: rgba(46, 91, 154, 0.14);
        --shadow: 0 24px 60px rgba(19, 37, 57, 0.12);
        --radius: 24px;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        color: var(--ink);
        font-family: "Avenir Next", "IBM Plex Sans", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(20, 108, 99, 0.18), transparent 28%),
          radial-gradient(circle at top right, rgba(162, 48, 50, 0.16), transparent 32%),
          linear-gradient(180deg, #f6f2ea 0%, #efe8dc 100%);
      }

      a { color: inherit; }

      .shell {
        max-width: 1440px;
        margin: 0 auto;
        padding: 32px 24px 56px;
      }

      .hero {
        position: relative;
        overflow: hidden;
        background: linear-gradient(135deg, rgba(19, 37, 57, 0.98), rgba(20, 108, 99, 0.88));
        color: white;
        border-radius: 32px;
        padding: 28px;
        box-shadow: var(--shadow);
      }

      .hero::after {
        content: "";
        position: absolute;
        right: -60px;
        top: -40px;
        width: 240px;
        height: 240px;
        background: radial-gradient(circle, rgba(255, 255, 255, 0.22), transparent 70%);
      }

      .hero-grid {
        position: relative;
        display: grid;
        grid-template-columns: minmax(0, 1.7fr) minmax(280px, 1fr);
        gap: 24px;
        z-index: 1;
      }

      .eyebrow {
        display: inline-flex;
        gap: 10px;
        align-items: center;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.12);
        color: rgba(255, 255, 255, 0.88);
        font-size: 13px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      h1 {
        margin: 18px 0 12px;
        font-family: Georgia, "Times New Roman", serif;
        font-size: clamp(2.2rem, 5vw, 4rem);
        line-height: 0.96;
        letter-spacing: -0.04em;
      }

      .hero p {
        max-width: 60ch;
        margin: 0;
        color: rgba(255, 255, 255, 0.8);
        font-size: 1.02rem;
        line-height: 1.6;
      }

      .hero-meta {
        display: grid;
        gap: 12px;
        align-content: start;
      }

      .meta-card {
        padding: 18px;
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.12);
        backdrop-filter: blur(12px);
      }

      .meta-card strong {
        display: block;
        margin-bottom: 6px;
        font-size: 0.85rem;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.66);
      }

      .meta-card span {
        display: block;
        font-size: 1.7rem;
        font-weight: 700;
      }

      .section-grid {
        display: grid;
        grid-template-columns: 1.15fr 1fr;
        gap: 24px;
        margin-top: 24px;
      }

      .panel {
        background: var(--panel);
        border-radius: var(--radius);
        border: 1px solid rgba(255, 255, 255, 0.7);
        box-shadow: var(--shadow);
        overflow: hidden;
      }

      .panel-head {
        padding: 24px 24px 18px;
        border-bottom: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.6), rgba(255, 255, 255, 0));
      }

      .panel-head h2 {
        margin: 0 0 6px;
        font-size: 1.35rem;
      }

      .panel-head p {
        margin: 0;
        color: var(--muted);
        line-height: 1.55;
      }

      .filters {
        display: grid;
        gap: 14px;
        padding: 20px 24px 0;
      }

      .filter-row {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
      }

      label {
        display: grid;
        gap: 8px;
        font-size: 0.86rem;
        color: var(--muted);
      }

      input,
      select,
      textarea,
      button {
        font: inherit;
      }

      input,
      select,
      textarea {
        width: 100%;
        border-radius: 14px;
        border: 1px solid rgba(19, 37, 57, 0.14);
        background: rgba(255, 255, 255, 0.9);
        color: var(--ink);
        padding: 12px 14px;
      }

      textarea {
        min-height: 88px;
        resize: vertical;
      }

      .filter-actions {
        display: flex;
        gap: 10px;
        align-items: center;
      }

      .button,
      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        border: 0;
        border-radius: 999px;
        padding: 11px 16px;
        cursor: pointer;
        text-decoration: none;
        font-weight: 600;
        transition: transform 120ms ease, opacity 120ms ease, background 120ms ease;
      }

      .button:hover,
      button:hover {
        transform: translateY(-1px);
      }

      .button-primary {
        background: var(--accent);
        color: white;
      }

      .button-quiet {
        background: rgba(19, 37, 57, 0.06);
        color: var(--ink);
      }

      .button-critical {
        background: var(--critical);
        color: white;
      }

      button[disabled] {
        opacity: 0.55;
        cursor: wait;
        transform: none;
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        padding: 20px 24px 0;
      }

      .stat {
        padding: 18px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.8);
        border: 1px solid rgba(19, 37, 57, 0.08);
      }

      .stat strong {
        display: block;
        font-size: 1.8rem;
        line-height: 1;
        margin-bottom: 8px;
      }

      .stat span {
        color: var(--muted);
      }

      .card-list {
        display: grid;
        gap: 16px;
        padding: 20px 24px 24px;
      }

      .visit-card,
      .escalation-card {
        border-radius: 22px;
        background: var(--panel-strong);
        border: 1px solid rgba(19, 37, 57, 0.08);
        padding: 20px;
        display: grid;
        gap: 16px;
      }

      .visit-card {
        position: relative;
        overflow: hidden;
      }

      .visit-card::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        width: 6px;
        background: linear-gradient(180deg, rgba(20, 108, 99, 0.95), rgba(46, 91, 154, 0.8));
      }

      .card-top {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: start;
      }

      .card-top h3 {
        margin: 0 0 6px;
        font-size: 1.15rem;
      }

      .subdued {
        margin: 0;
        color: var(--muted);
        line-height: 1.55;
      }

      .badge-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 7px 11px;
        border-radius: 999px;
        font-size: 0.82rem;
        font-weight: 600;
      }

      .pill-neutral {
        background: rgba(19, 37, 57, 0.07);
        color: var(--ink);
      }

      .pill-alert {
        background: rgba(166, 92, 0, 0.12);
        color: #7d4200;
      }

      .pill-critical {
        background: var(--critical-soft);
        color: var(--critical);
      }

      .pill-standard {
        background: var(--standard-soft);
        color: var(--standard);
      }

      .pill-urgent {
        background: var(--urgent-soft);
        color: var(--urgent);
      }

      .two-col {
        display: grid;
        grid-template-columns: 1.1fr 0.9fr;
        gap: 16px;
      }

      .stack {
        display: grid;
        gap: 10px;
      }

      ul {
        margin: 0;
        padding-left: 18px;
      }

      li + li {
        margin-top: 8px;
      }

      .agenda-item {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        border-radius: 16px;
        background: rgba(20, 108, 99, 0.06);
      }

      .agenda-item strong {
        display: block;
        margin-bottom: 4px;
      }

      .section-label {
        margin: 0 0 10px;
        font-size: 0.82rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .empty-state {
        padding: 32px 24px 36px;
        text-align: center;
        color: var(--muted);
      }

      .priority-critical {
        border-color: rgba(162, 48, 50, 0.24);
        box-shadow: inset 0 0 0 1px rgba(162, 48, 50, 0.08);
      }

      .priority-urgent {
        border-color: rgba(166, 92, 0, 0.22);
      }

      .priority-standard {
        border-color: rgba(46, 91, 154, 0.18);
      }

      details {
        border-top: 1px solid var(--line);
        padding-top: 14px;
      }

      summary {
        cursor: pointer;
        font-weight: 600;
      }

      .resolution-form {
        display: grid;
        gap: 12px;
        margin-top: 12px;
      }

      .inline-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .toast {
        position: fixed;
        right: 20px;
        bottom: 20px;
        min-width: 220px;
        max-width: 360px;
        border-radius: 18px;
        padding: 14px 16px;
        color: white;
        background: rgba(19, 37, 57, 0.94);
        box-shadow: 0 16px 40px rgba(19, 37, 57, 0.24);
        opacity: 0;
        transform: translateY(12px);
        pointer-events: none;
        transition: opacity 160ms ease, transform 160ms ease;
      }

      .toast[data-visible="true"] {
        opacity: 1;
        transform: translateY(0);
      }

      .caption {
        margin-top: 14px;
        color: rgba(255, 255, 255, 0.65);
        font-size: 0.88rem;
      }

      @media (max-width: 1180px) {
        .hero-grid,
        .section-grid,
        .filter-row,
        .stats,
        .two-col {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 720px) {
        .shell {
          padding: 18px 14px 40px;
        }

        .hero,
        .panel-head,
        .filters,
        .stats,
        .card-list {
          padding-left: 18px;
          padding-right: 18px;
        }

        .hero {
          border-radius: 26px;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        <div class="hero-grid">
          <div>
            <div class="eyebrow">Beacon Clinical Operations · Unified coordinator workbench</div>
            <h1>Keep visits ready.<br />Keep safety escalations moving.</h1>
            <p>
              A single operations surface for site coordinators and safety reviewers to prepare participants,
              verify protocol windows, and push adverse event follow-up forward without jumping between tools.
            </p>
            <div class="caption">
              ${escapeHtml(selectedSite?.name ?? 'No site configured')} · Generated ${escapeHtml(formatDateTime(model.generatedAt))}
            </div>
          </div>
          <div class="hero-meta">
            <div class="meta-card">
              <strong>Upcoming Visits</strong>
              <span>${model.visits.length}</span>
              <div>${escapeHtml(model.dateRange.from)} to ${escapeHtml(model.dateRange.to)}</div>
            </div>
            <div class="meta-card">
              <strong>Safety Inbox</strong>
              <span>${model.inbox.unacknowledged}</span>
              <div>Unacknowledged escalations requiring action</div>
            </div>
          </div>
        </div>
      </section>

      <div class="section-grid">
        <section class="panel" id="visit-prep">
          <div class="panel-head">
            <h2>Visit Preparation Summaries</h2>
            <p>
              Prepare each participant visit with protocol-aware checklists, estimated chair time, and readiness signals
              that surface issues before the patient arrives.
            </p>
          </div>
          <form class="filters" method="GET" action="/operations">
            <div class="filter-row">
              <label>
                Site
                <select name="site_id">
                  ${renderSiteOptions(model.sites, model.selectedSiteId)}
                </select>
              </label>
              <label>
                From
                <input type="date" name="from" value="${escapeHtml(model.dateRange.from)}" />
              </label>
              <label>
                To
                <input type="date" name="to" value="${escapeHtml(model.dateRange.to)}" />
              </label>
              <div class="filter-actions">
                <button class="button-primary" type="submit">Refresh worklist</button>
                <a class="button button-quiet" href="${escapeHtml(operationsQueryHref({ site_id: model.selectedSiteId }))}">Reset</a>
              </div>
            </div>
          </form>
          <div class="stats">
            <div class="stat">
              <strong>${model.visits.length}</strong>
              <span>Visits in range</span>
            </div>
            <div class="stat">
              <strong>${totalPrepMinutes}</strong>
              <span>Prep minutes scheduled</span>
            </div>
            <div class="stat">
              <strong>${requiredChecklistCount}</strong>
              <span>Required checklist items</span>
            </div>
            <div class="stat">
              <strong>${visitAlertCount + screeningParticipants}</strong>
              <span>Readiness risks to review</span>
            </div>
          </div>
          ${
            model.visits.length > 0
              ? `<div class="card-list">${model.visits
                  .map((summary) => renderVisitCard(summary))
                  .join('')}</div>`
              : `<div class="empty-state">No scheduled visits matched this site and date range. Adjust the filter window to widen the worklist.</div>`
          }
        </section>

        <section class="panel" id="ae-inbox">
          <div class="panel-head">
            <h2>Adverse Event Escalation Inbox</h2>
            <p>
              Triage serious and time-sensitive adverse events in clinically meaningful order, then acknowledge or resolve
              the escalation in-place with a minimal amount of friction.
            </p>
          </div>
          <form class="filters" method="GET" action="/operations">
            <div class="filter-row">
              <label>
                Site
                <select name="site_id">
                  ${renderSiteOptions(model.sites, model.selectedSiteId)}
                </select>
              </label>
              <label>
                Escalated To
                <select name="escalated_to">
                  <option value="">All recipients</option>
                  ${model.recipients
                    .map(
                      (recipient) =>
                        `<option value="${escapeHtml(recipient)}"${recipient === model.selectedRecipient ? ' selected' : ''}>${escapeHtml(recipient)}</option>`,
                    )
                    .join('')}
                </select>
              </label>
              <label>
                Priority
                <select name="priority">
                  <option value="">All priorities</option>
                  <option value="critical"${model.priorityFilter === 'critical' ? ' selected' : ''}>Critical</option>
                  <option value="urgent"${model.priorityFilter === 'urgent' ? ' selected' : ''}>Urgent</option>
                  <option value="standard"${model.priorityFilter === 'standard' ? ' selected' : ''}>Standard</option>
                </select>
              </label>
              <label>
                Acknowledgment
                <select name="acknowledged">
                  <option value="">All items</option>
                  <option value="false"${model.acknowledgedFilter === 'false' ? ' selected' : ''}>Unacknowledged</option>
                  <option value="true"${model.acknowledgedFilter === 'true' ? ' selected' : ''}>Acknowledged</option>
                </select>
              </label>
            </div>
            <div class="filter-actions">
              <input type="hidden" name="from" value="${escapeHtml(model.dateRange.from)}" />
              <input type="hidden" name="to" value="${escapeHtml(model.dateRange.to)}" />
              <button class="button-primary" type="submit">Apply inbox filters</button>
              <a class="button button-quiet" href="${escapeHtml(operationsQueryHref({ site_id: model.selectedSiteId, from: model.dateRange.from, to: model.dateRange.to }))}">Clear inbox filters</a>
            </div>
          </form>
          <div class="stats">
            <div class="stat">
              <strong>${model.inbox.total}</strong>
              <span>Total escalations</span>
            </div>
            <div class="stat">
              <strong>${model.inbox.by_priority.critical}</strong>
              <span>Critical cases</span>
            </div>
            <div class="stat">
              <strong>${model.inbox.unacknowledged}</strong>
              <span>Unacknowledged</span>
            </div>
            <div class="stat">
              <strong>${model.inbox.by_priority.urgent + model.inbox.by_priority.critical}</strong>
              <span>High priority items</span>
            </div>
          </div>
          ${
            model.inbox.items.length > 0
              ? `<div class="card-list">${model.inbox.items
                  .map((item) => renderEscalationCard(item))
                  .join('')}</div>`
              : `<div class="empty-state">The escalation inbox is clear for the current filter set.</div>`
          }
        </section>
      </div>
    </div>
    <div class="toast" id="toast"></div>
    <script id="ops-state" type="application/json">${safeState}</script>
    <script>
      (() => {
        const toast = document.getElementById('toast');
        const state = JSON.parse(document.getElementById('ops-state').textContent || '{}');

        const showToast = (message, isError = false) => {
          toast.textContent = message;
          toast.style.background = isError ? 'rgba(162, 48, 50, 0.96)' : 'rgba(19, 37, 57, 0.94)';
          toast.dataset.visible = 'true';
          window.clearTimeout(showToast._timer);
          showToast._timer = window.setTimeout(() => {
            toast.dataset.visible = 'false';
          }, 2600);
        };

        const refreshPage = () => {
          window.location.assign(state.currentUrl || window.location.pathname);
        };

        document.querySelectorAll('[data-ack-button]').forEach((button) => {
          button.addEventListener('click', async () => {
            const escalationId = button.getAttribute('data-ack-button');
            if (!escalationId) return;
            button.disabled = true;
            try {
              const response = await fetch('/api/escalations/' + encodeURIComponent(escalationId) + '/acknowledge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
              });
              if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                throw new Error(payload.error || 'Failed to acknowledge escalation');
              }
              showToast('Escalation acknowledged');
              window.setTimeout(refreshPage, 350);
            } catch (error) {
              showToast(error.message || 'Failed to acknowledge escalation', true);
            } finally {
              button.disabled = false;
            }
          });
        });

        document.querySelectorAll('[data-resolve-form]').forEach((form) => {
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const escalationId = form.getAttribute('data-resolve-form');
            const textarea = form.querySelector('textarea[name=\"resolution_note\"]');
            const submit = form.querySelector('button[type=\"submit\"]');
            const note = textarea.value.trim();
            if (!escalationId || !note) {
              showToast('Resolution note is required', true);
              return;
            }
            submit.disabled = true;
            try {
              const response = await fetch('/api/escalations/' + encodeURIComponent(escalationId) + '/resolve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ resolution_note: note }),
              });
              if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                throw new Error(payload.error || 'Failed to resolve escalation');
              }
              showToast('Escalation resolved');
              window.setTimeout(refreshPage, 350);
            } catch (error) {
              showToast(error.message || 'Failed to resolve escalation', true);
            } finally {
              submit.disabled = false;
            }
          });
        });
      })();
    </script>
  </body>
</html>`;
}

function renderVisitCard(summary: VisitPreparationSummary): string {
  const today = currentDate();
  const dueInDays = diffInDays(today, summary.visit.scheduled_date);
  const requiredItems = summary.preparation_checklist.filter((item) => item.required);
  const optionalItems = summary.preparation_checklist.filter((item) => !item.required);
  const timingBadge =
    dueInDays < 0
      ? `<span class="pill pill-alert">Past due by ${Math.abs(dueInDays)} day${Math.abs(dueInDays) === 1 ? '' : 's'}</span>`
      : dueInDays === 0
        ? `<span class="pill pill-critical">Due today</span>`
        : dueInDays === 1
          ? `<span class="pill pill-alert">Due tomorrow</span>`
          : `<span class="pill pill-neutral">Due in ${dueInDays} days</span>`;
  const windowState =
    summary.visit.scheduled_date < summary.visit.window_start
      ? 'Before protocol window'
      : summary.visit.scheduled_date > summary.visit.window_end
        ? 'Outside protocol window'
        : `Window ${formatDate(summary.visit.window_start)} to ${formatDate(summary.visit.window_end)}`;

  return `
    <article class="visit-card">
      <div class="card-top">
        <div>
          <h3>${escapeHtml(summary.visit.visit_code)} · ${escapeHtml(summary.visit.visit_label)}</h3>
          <p class="subdued">
            Participant ${escapeHtml(summary.participant.external_id)} (${escapeHtml(summary.participant.initials)}) ·
            ${escapeHtml(summary.participant.cohort ?? 'Unassigned cohort')} ·
            ${escapeHtml(formatDate(summary.visit.scheduled_date))}
          </p>
        </div>
        <div class="badge-row">
          ${timingBadge}
          <span class="pill pill-neutral">${escapeHtml(windowState)}</span>
          ${
            summary.participant.status === 'screening'
              ? `<span class="pill pill-alert">Screening status</span>`
              : ''
          }
        </div>
      </div>
      <div class="two-col">
        <div class="stack">
          <div>
            <p class="section-label">Required Checklist</p>
            <ul>
              ${requiredItems
                .map((item) => `<li>${escapeHtml(item.label)}</li>`)
                .join('')}
            </ul>
          </div>
          <div>
            <p class="section-label">Optional Prep</p>
            <ul>
              ${optionalItems
                .map((item) => `<li>${escapeHtml(item.label)}</li>`)
                .join('')}
            </ul>
          </div>
        </div>
        <div class="stack">
          <div>
            <p class="section-label">Visit Agenda</p>
            ${summary.procedures
              .map(
                (procedure) => `
                  <div class="agenda-item">
                    <div>
                      <strong>${escapeHtml(procedure.procedure_name)}</strong>
                      <div class="subdued">${escapeHtml(procedure.procedure_code)}</div>
                    </div>
                    <div>${procedure.estimated_minutes} min</div>
                  </div>
                `,
              )
              .join('')}
          </div>
          <div class="badge-row">
            <span class="pill pill-standard">${summary.total_estimated_minutes} minutes total</span>
            ${
              summary.alerts.length > 0
                ? summary.alerts
                    .map((alert) => `<span class="pill pill-alert">${escapeHtml(alert)}</span>`)
                    .join('')
                : `<span class="pill pill-neutral">No blocking alerts</span>`
            }
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderEscalationCard(item: EscalationInboxItem): string {
  const priorityClass =
    item.escalation.priority === 'critical'
      ? 'priority-critical'
      : item.escalation.priority === 'urgent'
        ? 'priority-urgent'
        : 'priority-standard';
  const priorityPill =
    item.escalation.priority === 'critical'
      ? 'pill-critical'
      : item.escalation.priority === 'urgent'
        ? 'pill-alert'
        : 'pill-standard';

  return `
    <article class="escalation-card ${priorityClass}">
      <div class="card-top">
        <div>
          <h3>${escapeHtml(item.adverse_event.event_term)}</h3>
          <p class="subdued">
            ${escapeHtml(item.site_name)} · Participant ${escapeHtml(item.participant.external_id)} (${escapeHtml(item.participant.initials)}) ·
            Onset ${escapeHtml(formatDate(item.adverse_event.onset_date))}
          </p>
        </div>
        <div class="badge-row">
          <span class="pill ${priorityPill}">${escapeHtml(item.escalation.priority)}</span>
          ${
            item.adverse_event.is_serious
              ? `<span class="pill pill-critical">Serious AE</span>`
              : `<span class="pill pill-neutral">Non-serious</span>`
          }
          ${
            item.escalation.acknowledged_at
              ? `<span class="pill pill-neutral">Acknowledged</span>`
              : `<span class="pill pill-alert">Unacknowledged</span>`
          }
        </div>
      </div>
      <div class="two-col">
        <div class="stack">
          <div>
            <p class="section-label">Escalation context</p>
            <p class="subdued">${escapeHtml(item.adverse_event.description)}</p>
          </div>
          <div>
            <p class="section-label">Reason</p>
            <p class="subdued">${escapeHtml(item.escalation.reason)}</p>
          </div>
          ${
            item.escalation.action_required
              ? `<div><p class="section-label">Action required</p><p class="subdued">${escapeHtml(item.escalation.action_required)}</p></div>`
              : ''
          }
        </div>
        <div class="stack">
          <div class="badge-row">
            <span class="pill pill-neutral">${item.days_open} day${item.days_open === 1 ? '' : 's'} open</span>
            <span class="pill pill-neutral">${escapeHtml(item.adverse_event.severity.replace('_', ' '))}</span>
            <span class="pill pill-neutral">Causality ${escapeHtml(item.adverse_event.causality)}</span>
          </div>
          <div class="inline-actions">
            ${
              item.escalation.acknowledged_at
                ? ''
                : `<button type="button" class="button-primary" data-ack-button="${escapeHtml(item.escalation.id)}">Acknowledge</button>`
            }
            ${
              item.escalation.resolved_at
                ? `<span class="pill pill-neutral">Resolved ${escapeHtml(formatDateTime(item.escalation.resolved_at))}</span>`
                : ''
            }
          </div>
          ${
            item.escalation.resolved_at
              ? `<div><p class="section-label">Resolution note</p><p class="subdued">${escapeHtml(item.escalation.resolution_note ?? 'No note provided')}</p></div>`
              : `<details>
                  <summary>Resolve escalation</summary>
                  <form class="resolution-form" data-resolve-form="${escapeHtml(item.escalation.id)}">
                    <textarea name="resolution_note" placeholder="Document clinical disposition, outreach completed, or next follow-up step."></textarea>
                    <button type="submit" class="button-critical">Resolve and close</button>
                  </form>
                </details>`
          }
        </div>
      </div>
    </article>
  `;
}

function renderSiteOptions(sites: Site[], selectedSiteId: string): string {
  if (sites.length === 0) {
    return '<option value="">No site data</option>';
  }

  return sites
    .map(
      (site) =>
        `<option value="${escapeHtml(site.id)}"${site.id === selectedSiteId ? ' selected' : ''}>${escapeHtml(site.name)}</option>`,
    )
    .join('');
}

function operationsQueryHref(query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value) {
      params.set(key, value);
    }
  });

  const suffix = params.toString();
  return suffix ? `/operations?${suffix}` : '/operations';
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map((part) => parseInt(part, 10));
  const monthLabels = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  if (!year || !month || !day) {
    return date;
  }

  return `${monthLabels[month - 1]} ${day}, ${year}`;
}

function formatDateTime(value: string): string {
  return value.replace('T', ' ').replace('.000Z', ' UTC');
}

function currentDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function diffInDays(fromDate: string, toDate: string): number {
  const from = new Date(`${fromDate}T00:00:00Z`).getTime();
  const to = new Date(`${toDate}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86400000);
}

function isIsoDate(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}
