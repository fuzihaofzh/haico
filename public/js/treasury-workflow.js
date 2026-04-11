(function(global) {
  function escapeHtml(value) {
    if (typeof global.esc === 'function') return global.esc(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(char) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[char] || char;
    });
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function formatDelta(value) {
    if (!value) return 'No change';
    return (value > 0 ? '+' : '') + value + 'd';
  }

  function pluralize(count, singular, plural) {
    return count === 1 ? singular : plural;
  }

  function toneClass(tone) {
    return tone ? ' is-' + tone : '';
  }

  var REGION_BLUEPRINTS = [
    {
      key: 'americas',
      label: 'Americas cash hub',
      owner: 'Regional treasurer',
      entities: 5,
      current_warning: 9,
      current_critical: 5,
      proposed_warning: 8,
      proposed_critical: 4,
      forecast_variance: 4.2,
      concentration: 'Sweeps settle intraday across USD entities.',
      rationale: 'Tighter same-day sweep coverage supports faster escalation without widening false positives.',
      approval_path: 'Delegated treasury lead',
      policy_basis: 'In-policy delta under 2 days with variance below 5%.',
      evidence_tag: 'NA-LIQ-014',
    },
    {
      key: 'emea',
      label: 'EMEA operating cluster',
      owner: 'Liquidity manager',
      entities: 7,
      current_warning: 10,
      current_critical: 6,
      proposed_warning: 11,
      proposed_critical: 7,
      forecast_variance: 6.4,
      concentration: 'Cross-border cutoffs and pooled cash concentration add settlement lag.',
      rationale: 'A one-day buffer increase keeps alerts actionable when euro and sterling sweeps miss same-day windows.',
      approval_path: 'Dual approval',
      policy_basis: 'Out-of-band change because both threshold bands move upward.',
      evidence_tag: 'EMEA-LIQ-022',
    },
    {
      key: 'apac',
      label: 'APAC collections corridor',
      owner: 'Treasury operations',
      entities: 6,
      current_warning: 11,
      current_critical: 7,
      proposed_warning: 13,
      proposed_critical: 8,
      forecast_variance: 7.1,
      concentration: 'Cross-currency settlements and overnight funding handoffs create longer liquidity lead times.',
      rationale: 'Threshold widening reduces noise while preserving a clear red band for funding interventions.',
      approval_path: 'Treasury + controller',
      policy_basis: 'Requires sign-off because the amber band expands by more than 15%.',
      evidence_tag: 'APAC-LIQ-031',
    },
    {
      key: 'latam',
      label: 'LATAM restricted markets',
      owner: 'Regional controller',
      entities: 4,
      current_warning: 13,
      current_critical: 9,
      proposed_warning: 15,
      proposed_critical: 10,
      forecast_variance: 8.6,
      concentration: 'Capital controls and manual concentration steps increase exception handling.',
      rationale: 'A wider warning band avoids churn and routes only material funding risks into the approval queue.',
      approval_path: 'CFO exception',
      policy_basis: 'High-friction market requires explicit policy override and retained evidence.',
      evidence_tag: 'LATAM-LIQ-009',
    },
  ];

  function deriveRegionState(region, context, index) {
    var pendingApprovals = context.pendingApprovals;
    var agentErrors = context.agentErrors;
    var activeIssues = context.activeIssues;
    var escalations = context.escalations;
    var warningDelta = region.proposed_warning - region.current_warning;
    var criticalDelta = region.proposed_critical - region.current_critical;
    var requiresApproval = region.approval_path !== 'Delegated treasury lead';
    var isQueued = requiresApproval && index < pendingApprovals;
    var hasException = agentErrors > 0 && region.key === 'latam';
    var inReview = !isQueued && requiresApproval && activeIssues > 2 && index === 1;
    var tone = 'success';
    var status = 'Ready to publish';

    if (isQueued) {
      tone = 'warning';
      status = 'Awaiting approval';
    } else if (hasException) {
      tone = 'critical';
      status = 'Exception review';
    } else if (inReview) {
      tone = 'accent';
      status = 'Change package in review';
    }

    return {
      key: region.key,
      label: region.label,
      owner: region.owner,
      entities: region.entities,
      current_warning: region.current_warning,
      current_critical: region.current_critical,
      proposed_warning: region.proposed_warning,
      proposed_critical: region.proposed_critical,
      warning_delta: warningDelta,
      critical_delta: criticalDelta,
      forecast_variance: region.forecast_variance,
      concentration: region.concentration,
      rationale: region.rationale,
      approval_path: region.approval_path,
      policy_basis: region.policy_basis,
      evidence_tag: region.evidence_tag,
      tone: tone,
      status: status,
      requires_approval: requiresApproval,
      escalation_count: clamp(escalations - index, 0, 3),
    };
  }

  function buildModel(input) {
    var project = input && input.project ? input.project : {};
    var workflow = input && input.workflow ? input.workflow : {};
    var approvals = Array.isArray(input && input.approvals) ? input.approvals : [];
    var activeIssues = Array.isArray(input && input.activeIssues) ? input.activeIssues : [];
    var agents = Array.isArray(workflow.agents) ? workflow.agents : [];
    var recentMessages = Array.isArray(workflow.recent_messages) ? workflow.recent_messages : [];
    var pendingApprovals = approvals.length || (Array.isArray(workflow.pending_approvals) ? workflow.pending_approvals.length : 0);
    var runningAgents = agents.filter(function(agent) { return agent.status === 'running'; }).length;
    var agentErrors = agents.filter(function(agent) { return agent.status === 'error'; }).length;
    var controlledEntities = REGION_BLUEPRINTS.reduce(function(total, region) { return total + region.entities; }, 0);
    var escalations = Math.max(1, Math.min(REGION_BLUEPRINTS.length, Math.ceil((activeIssues.length || workflow.total_active_issues || 0) / 2) || 1));
    var context = {
      pendingApprovals: pendingApprovals,
      agentErrors: agentErrors,
      activeIssues: activeIssues.length || workflow.total_active_issues || 0,
      escalations: escalations,
    };
    var regions = REGION_BLUEPRINTS.map(function(region, index) {
      return deriveRegionState(region, context, index);
    });
    var readyRegions = regions.filter(function(region) { return region.status === 'Ready to publish'; }).length;
    var auditCoverage = clamp(82 + (recentMessages.length > 4 ? 6 : 0) + (pendingApprovals > 0 ? 4 : 0), 82, 98);
    var withinPolicyCount = regions.filter(function(region) { return !region.requires_approval; }).length;
    var headline = project.name || 'Treasury Workflow';
    var summary = project.task_description || project.description || 'Tune regional liquidity thresholds with explicit controls, approvals, and evidence.';
    var approvalHeadline = pendingApprovals > 0
      ? pendingApprovals + ' approval ' + pluralize(pendingApprovals, 'queue', 'queues') + ' protecting threshold changes'
      : 'No open approvals blocking threshold publication';

    return {
      headline: headline,
      summary: summary,
      approval_headline: approvalHeadline,
      stats: [
        {
          label: 'Controlled entities',
          value: String(controlledEntities),
          hint: 'Regional entities covered by the tuned liquidity policy.',
        },
        {
          label: 'Ready to publish',
          value: String(readyRegions) + '/' + String(regions.length),
          hint: 'Threshold packages that can move forward without waiting on new evidence.',
        },
        {
          label: 'Delegated changes',
          value: String(withinPolicyCount),
          hint: 'Changes still inside delegated authority.',
        },
        {
          label: 'Audit coverage',
          value: String(auditCoverage) + '%',
          hint: 'Evidence completeness across approvals, handoffs, and open remediation.',
        },
      ],
      guardrails: [
        {
          title: 'Decision rails',
          tone: pendingApprovals > 0 ? 'warning' : 'success',
          items: [
            'Auto-apply only when band movement stays within 2 days and forecast variance is below 5%.',
            'Route any upward shift or exception market change into dual approval before publication.',
            'Hold publication whenever an error-state agent or unresolved exception issue is attached to the package.',
          ],
        },
        {
          title: 'Audit packet',
          tone: agentErrors > 0 ? 'critical' : 'accent',
          items: [
            'Attach the regional rationale, evidence tag, and approver path to every threshold recommendation.',
            'Retain issue references and workflow handoffs so treasury can prove who changed what and why.',
            'Surface only material breaches into the escalation queue to reduce noise for finance operations.',
          ],
        },
      ],
      rails: [
        {
          step: '1. Detect',
          title: 'Collect threshold pressure',
          detail: (activeIssues.length || workflow.total_active_issues || 0) + ' active issue ' + pluralize(activeIssues.length || workflow.total_active_issues || 0, 'signal', 'signals') + ' flowing into the tuning layer.',
          tone: 'accent',
        },
        {
          step: '2. Simulate',
          title: 'Validate regional deltas',
          detail: readyRegions + ' region ' + pluralize(readyRegions, 'package', 'packages') + ' already sit inside policy rails.',
          tone: 'success',
        },
        {
          step: '3. Approve',
          title: 'Gate sensitive moves',
          detail: approvalHeadline,
          tone: pendingApprovals > 0 ? 'warning' : 'success',
        },
        {
          step: '4. Publish',
          title: 'Lock the audit trail',
          detail: recentMessages.length + ' recent handoff ' + pluralize(recentMessages.length, 'record', 'records') + ' retained with evidence tags.',
          tone: agentErrors > 0 ? 'critical' : 'accent',
        },
      ],
      evidence: [
        {
          label: 'Workflow agents',
          value: String(agents.length),
          hint: runningAgents + ' running, ' + agentErrors + ' in error state.',
        },
        {
          label: 'Pending approvals',
          value: String(pendingApprovals),
          hint: 'Sensitive threshold movements stay gated until approval is closed.',
        },
        {
          label: 'Recent handoffs',
          value: String(recentMessages.length),
          hint: 'Cross-agent coordination retained for audit replay.',
        },
      ],
      regions: regions,
    };
  }

  function renderStats(stats) {
    return stats.map(function(stat) {
      return ''
        + '<article class="treasury-stat-card">'
        + '<div class="treasury-stat-value">' + escapeHtml(stat.value) + '</div>'
        + '<div class="treasury-stat-label">' + escapeHtml(stat.label) + '</div>'
        + '<p class="treasury-stat-hint">' + escapeHtml(stat.hint) + '</p>'
        + '</article>';
    }).join('');
  }

  function renderRegions(regions) {
    return regions.map(function(region) {
      return ''
        + '<article class="treasury-region-card' + toneClass(region.tone) + '">'
        + '<div class="treasury-region-header">'
        + '<div>'
        + '<div class="treasury-region-eyebrow">' + escapeHtml(region.owner) + ' · ' + region.entities + ' entities</div>'
        + '<h3>' + escapeHtml(region.label) + '</h3>'
        + '</div>'
        + '<span class="treasury-badge' + toneClass(region.tone) + '">' + escapeHtml(region.status) + '</span>'
        + '</div>'
        + '<div class="treasury-threshold-grid">'
        + '<div class="treasury-threshold-block">'
        + '<span class="treasury-threshold-label">Warning band</span>'
        + '<strong>' + region.proposed_warning + 'd</strong>'
        + '<span>Current ' + region.current_warning + 'd · ' + formatDelta(region.warning_delta) + '</span>'
        + '</div>'
        + '<div class="treasury-threshold-block">'
        + '<span class="treasury-threshold-label">Critical band</span>'
        + '<strong>' + region.proposed_critical + 'd</strong>'
        + '<span>Current ' + region.current_critical + 'd · ' + formatDelta(region.critical_delta) + '</span>'
        + '</div>'
        + '<div class="treasury-threshold-block">'
        + '<span class="treasury-threshold-label">Forecast variance</span>'
        + '<strong>' + region.forecast_variance.toFixed(1) + '%</strong>'
        + '<span>' + region.escalation_count + ' live escalation ' + pluralize(region.escalation_count, 'signal', 'signals') + '</span>'
        + '</div>'
        + '</div>'
        + '<p class="treasury-region-copy">' + escapeHtml(region.concentration) + '</p>'
        + '<p class="treasury-region-copy">' + escapeHtml(region.rationale) + '</p>'
        + '<div class="treasury-region-footer">'
        + '<div>'
        + '<span class="treasury-region-meta-label">Approval path</span>'
        + '<strong>' + escapeHtml(region.approval_path) + '</strong>'
        + '</div>'
        + '<div>'
        + '<span class="treasury-region-meta-label">Evidence tag</span>'
        + '<strong>' + escapeHtml(region.evidence_tag) + '</strong>'
        + '</div>'
        + '</div>'
        + '<div class="treasury-region-policy">' + escapeHtml(region.policy_basis) + '</div>'
        + '</article>';
    }).join('');
  }

  function renderGuardrails(guardrails) {
    return guardrails.map(function(section) {
      var items = section.items.map(function(item) {
        return '<li>' + escapeHtml(item) + '</li>';
      }).join('');
      return ''
        + '<section class="treasury-side-card' + toneClass(section.tone) + '">'
        + '<div class="treasury-side-title">' + escapeHtml(section.title) + '</div>'
        + '<ul class="treasury-list">' + items + '</ul>'
        + '</section>';
    }).join('');
  }

  function renderRails(rails) {
    return rails.map(function(rail) {
      return ''
        + '<div class="treasury-rail' + toneClass(rail.tone) + '">'
        + '<div class="treasury-rail-step">' + escapeHtml(rail.step) + '</div>'
        + '<div>'
        + '<div class="treasury-rail-title">' + escapeHtml(rail.title) + '</div>'
        + '<p class="treasury-rail-detail">' + escapeHtml(rail.detail) + '</p>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  function renderEvidence(evidence) {
    return evidence.map(function(item) {
      return ''
        + '<div class="treasury-evidence-row">'
        + '<div>'
        + '<span class="treasury-evidence-label">' + escapeHtml(item.label) + '</span>'
        + '<p>' + escapeHtml(item.hint) + '</p>'
        + '</div>'
        + '<strong>' + escapeHtml(item.value) + '</strong>'
        + '</div>';
    }).join('');
  }

  function render(model) {
    return ''
      + '<section class="treasury-layer card">'
      + '<div class="treasury-hero">'
      + '<div>'
      + '<div class="treasury-overline">Trusted Treasury Workflow</div>'
      + '<h2>Treasury Control Layer</h2>'
      + '<p>' + escapeHtml(model.summary) + '</p>'
      + '</div>'
      + '<div class="treasury-hero-panel">'
      + '<span class="treasury-badge is-accent">' + escapeHtml(model.headline) + '</span>'
      + '<strong>' + escapeHtml(model.approval_headline) + '</strong>'
      + '<p>Regional threshold tuning stays fast because policy rails, approver paths, and evidence tags travel together.</p>'
      + '</div>'
      + '</div>'
      + '<div class="treasury-stats">' + renderStats(model.stats) + '</div>'
      + '<div class="treasury-main-grid">'
      + '<div class="treasury-region-grid">' + renderRegions(model.regions) + '</div>'
      + '<aside class="treasury-side-column">'
      + renderGuardrails(model.guardrails)
      + '<section class="treasury-side-card">'
      + '<div class="treasury-side-title">Execution path</div>'
      + '<div class="treasury-rails">' + renderRails(model.rails) + '</div>'
      + '</section>'
      + '<section class="treasury-side-card">'
      + '<div class="treasury-side-title">Evidence ledger</div>'
      + '<div class="treasury-evidence">' + renderEvidence(model.evidence) + '</div>'
      + '</section>'
      + '</aside>'
      + '</div>'
      + '</section>';
  }

  var api = {
    buildModel: buildModel,
    render: render,
    _test: {
      REGION_BLUEPRINTS: REGION_BLUEPRINTS,
      deriveRegionState: deriveRegionState,
    },
  };

  global.HAICOTreasuryWorkflow = api;
  if (global.window && global.window !== global) {
    global.window.HAICOTreasuryWorkflow = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
