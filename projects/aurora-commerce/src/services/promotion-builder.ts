export type PromotionObjective = 'margin' | 'acquisition' | 'clearance';
export type PromotionMechanic = 'threshold' | 'bundle' | 'tiered';
export type ChannelPresetId = 'balanced' | 'urgent' | 'loyalty';
export type FulfillmentPresetId = 'network-safe' | 'pickup-heavy' | 'metro-fast';
export type LaunchDay = 'Tuesday' | 'Wednesday' | 'Thursday';

export interface PromotionBuilderDraft {
  objective: PromotionObjective;
  mechanic: PromotionMechanic;
  discountPercent: number;
  thresholdAmount: number;
  budgetK: number;
  inventoryBufferPercent: number;
  vipWindowHours: number;
  channelPreset: ChannelPresetId;
  fulfillmentPreset: FulfillmentPresetId;
  launchDay: LaunchDay;
  stackable: boolean;
  autoApply: boolean;
  giftWithPurchase: boolean;
}

export interface PromotionBuilderSeed {
  objectives: Array<{ id: PromotionObjective; label: string; detail: string }>;
  mechanics: Array<{ id: PromotionMechanic; label: string; detail: string }>;
  channelPresets: Array<{
    id: ChannelPresetId;
    label: string;
    detail: string;
    mix: Record<'email' | 'sms' | 'onsite' | 'paid', number>;
  }>;
  fulfillmentPresets: Array<{
    id: FulfillmentPresetId;
    label: string;
    detail: string;
    pickupShare: number;
    sameDayShare: number;
    activeStores: number;
  }>;
  launchDays: LaunchDay[];
  defaults: PromotionBuilderDraft;
}

export interface PromotionBuilderPreview {
  draft: PromotionBuilderDraft;
  presetContext: {
    channels: Record<'email' | 'sms' | 'onsite' | 'paid', number>;
    pickupShare: number;
    sameDayShare: number;
    shipToHomeShare: number;
    activeStores: number;
  };
  metrics: {
    demandIndex: number;
    projectedOrders: number;
    averageOrderValueLift: number;
    marginPressure: number;
    checkoutComplexity: number;
    fulfillmentRisk: number;
    launchReadiness: number;
  };
  panels: Array<{
    id: 'campaign' | 'catalog' | 'checkout' | 'fulfillment';
    title: string;
    eyebrow: string;
    score: string;
    detail: string;
  }>;
  guardrails: Array<{
    label: string;
    status: 'pass' | 'watch' | 'risk';
    detail: string;
  }>;
  acceptanceCriteria: Array<{
    label: string;
    passed: boolean;
    detail: string;
  }>;
  recommendations: string[];
  launchBrief: {
    title: string;
    summary: string;
    timeline: string[];
  };
  heroBannerChecklist: {
    gate: {
      status: 'ready' | 'watch' | 'blocked';
      label: string;
      summary: string;
      completionPercent: number;
      readyCount: number;
      watchCount: number;
      blockedCount: number;
      totalCount: number;
    };
    sections: Array<{
      title: string;
      detail: string;
      items: Array<{
        label: string;
        status: 'ready' | 'watch' | 'blocked';
        detail: string;
      }>;
    }>;
    acceptanceCriteria: string[];
  };
}

const objectiveConfig: Record<PromotionObjective, { demand: number; margin: number; fulfillment: number }> = {
  margin: { demand: 0.92, margin: 1.15, fulfillment: 0.92 },
  acquisition: { demand: 1.08, margin: 1.0, fulfillment: 1.02 },
  clearance: { demand: 1.18, margin: 0.82, fulfillment: 1.16 },
};

const mechanicComplexity: Record<PromotionMechanic, number> = {
  threshold: 12,
  bundle: 18,
  tiered: 24,
};

const seed: PromotionBuilderSeed = {
  objectives: [
    { id: 'margin', label: 'Margin Defense', detail: 'Protect gross margin while nudging basket size.' },
    { id: 'acquisition', label: 'New Customer Push', detail: 'Expand reach without overloading checkout or ops.' },
    { id: 'clearance', label: 'Inventory Clearance', detail: 'Move stale units while keeping fulfillment predictable.' },
  ],
  mechanics: [
    { id: 'threshold', label: 'Threshold Offer', detail: 'Spend unlock with lower checkout complexity.' },
    { id: 'bundle', label: 'Bundle Builder', detail: 'Cross-sell catalog depth with medium operational load.' },
    { id: 'tiered', label: 'Tiered Discount', detail: 'Highest conversion upside, highest orchestration pressure.' },
  ],
  channelPresets: [
    {
      id: 'balanced',
      label: 'Balanced Launch',
      detail: 'Stable reach across owned and paid surfaces.',
      mix: { email: 32, sms: 16, onsite: 28, paid: 24 },
    },
    {
      id: 'urgent',
      label: 'Urgency Burst',
      detail: 'Higher SMS and paid intensity for compressed launch windows.',
      mix: { email: 24, sms: 24, onsite: 22, paid: 30 },
    },
    {
      id: 'loyalty',
      label: 'Loyalty First',
      detail: 'Prioritize member reactivation with gentler paid demand.',
      mix: { email: 40, sms: 12, onsite: 32, paid: 16 },
    },
  ],
  fulfillmentPresets: [
    {
      id: 'network-safe',
      label: 'Network Safe',
      detail: 'Lean on ship-to-home with measured pickup participation.',
      pickupShare: 18,
      sameDayShare: 8,
      activeStores: 42,
    },
    {
      id: 'pickup-heavy',
      label: 'Pickup Heavy',
      detail: 'Drive store pickup to release pressure on parcel capacity.',
      pickupShare: 34,
      sameDayShare: 6,
      activeStores: 68,
    },
    {
      id: 'metro-fast',
      label: 'Metro Fast',
      detail: 'Aggressive same-day posture for top metro markets.',
      pickupShare: 22,
      sameDayShare: 18,
      activeStores: 28,
    },
  ],
  launchDays: ['Tuesday', 'Wednesday', 'Thursday'],
  defaults: {
    objective: 'acquisition',
    mechanic: 'tiered',
    discountPercent: 18,
    thresholdAmount: 120,
    budgetK: 90,
    inventoryBufferPercent: 18,
    vipWindowHours: 12,
    channelPreset: 'balanced',
    fulfillmentPreset: 'network-safe',
    launchDay: 'Thursday',
    stackable: false,
    autoApply: true,
    giftWithPurchase: false,
  },
};

export function getPromotionBuilderSeed(): PromotionBuilderSeed {
  return seed;
}

export function buildPromotionPreview(input: Partial<PromotionBuilderDraft> = {}): PromotionBuilderPreview {
  const draft = normalizeDraft(input);
  const objective = objectiveConfig[draft.objective];
  const channelPreset = seed.channelPresets.find((item) => item.id === draft.channelPreset) ?? seed.channelPresets[0];
  const fulfillmentPreset =
    seed.fulfillmentPresets.find((item) => item.id === draft.fulfillmentPreset) ?? seed.fulfillmentPresets[0];

  const channelEnergy =
    channelPreset.mix.email * 0.28 +
    channelPreset.mix.sms * 0.56 +
    channelPreset.mix.onsite * 0.34 +
    channelPreset.mix.paid * 0.44;

  const demandIndex = clamp(
    Math.round(
      42 +
        draft.discountPercent * 1.9 +
        draft.budgetK * 0.22 +
        draft.vipWindowHours * 0.48 +
        channelEnergy * objective.demand +
        (draft.mechanic === 'tiered' ? 8 : draft.mechanic === 'bundle' ? 5 : 2)
    ),
    48,
    190
  );

  const projectedOrders = Math.round(340 + demandIndex * 18 + draft.budgetK * 7);
  const averageOrderValueLift = clamp(
    Math.round(draft.thresholdAmount / 18 + (draft.mechanic === 'bundle' ? 5 : draft.mechanic === 'tiered' ? 7 : 3)),
    4,
    24
  );

  const marginPressure = clamp(
    Math.round(
      draft.discountPercent * 1.55 * objective.margin +
        draft.budgetK * 0.08 +
        (draft.stackable ? 10 : 0) +
        (draft.giftWithPurchase ? 7 : 0) +
        (draft.autoApply ? 4 : 0) -
        draft.thresholdAmount * 0.12
    ),
    6,
    92
  );

  const checkoutComplexity = clamp(
    Math.round(
      mechanicComplexity[draft.mechanic] +
        (draft.stackable ? 16 : 0) +
        (draft.autoApply ? 7 : 0) +
        (draft.giftWithPurchase ? 11 : 0) +
        (draft.vipWindowHours > 0 ? 4 : 0)
    ),
    10,
    88
  );

  const fulfillmentRisk = clamp(
    Math.round(
      fulfillmentPreset.pickupShare * 0.65 +
        fulfillmentPreset.sameDayShare * 1.32 +
        Math.max(0, demandIndex - draft.inventoryBufferPercent * 4.4) * 0.36 * objective.fulfillment -
        fulfillmentPreset.activeStores * 0.08
    ),
    8,
    96
  );

  const launchDayBonus = draft.launchDay === 'Thursday' ? 4 : draft.launchDay === 'Wednesday' ? 2 : 1;
  const launchReadiness = clamp(
    Math.round(
      94 -
        marginPressure * 0.24 -
        checkoutComplexity * 0.34 -
        fulfillmentRisk * 0.28 +
        draft.inventoryBufferPercent * 0.9 +
        draft.vipWindowHours * 0.18 +
        launchDayBonus
    ),
    36,
    98
  );

  const guardrails: PromotionBuilderPreview['guardrails'] = [
    {
      label: 'Catalog Buffer',
      status: draft.inventoryBufferPercent >= 18 ? 'pass' : draft.inventoryBufferPercent >= 14 ? 'watch' : 'risk',
      detail:
        draft.inventoryBufferPercent >= 18
          ? `Buffer locked at ${draft.inventoryBufferPercent}% for launch-day replenishment.`
          : `Only ${draft.inventoryBufferPercent}% buffer remains; replenishment timing is tight.`,
    },
    {
      label: 'Checkout Rules',
      status: checkoutComplexity <= 34 ? 'pass' : checkoutComplexity <= 48 ? 'watch' : 'risk',
      detail:
        checkoutComplexity <= 34
          ? 'Rule stack stays within the standard QA lane.'
          : checkoutComplexity <= 48
            ? 'Additional pricing and cart QA required before publish.'
            : 'Cart logic is likely to challenge weekly release cadence.',
    },
    {
      label: 'Fulfillment Load',
      status: fulfillmentRisk <= 28 ? 'pass' : fulfillmentRisk <= 42 ? 'watch' : 'risk',
      detail:
        fulfillmentRisk <= 28
          ? 'Network capacity supports the proposed launch shape.'
          : fulfillmentRisk <= 42
            ? 'Same-day and pickup demand should be monitored during the first 6 hours.'
            : 'Ops load is above the preferred launch envelope.',
    },
    {
      label: 'Campaign Cadence',
      status: launchReadiness >= 78 ? 'pass' : launchReadiness >= 68 ? 'watch' : 'risk',
      detail:
        launchReadiness >= 78
          ? 'Ready for the standard weekly launch review.'
          : launchReadiness >= 68
            ? 'Launch can proceed with explicit operator sign-off on risks.'
            : 'Current draft misses the weekly launch readiness bar.',
    },
  ];

  const acceptanceCriteria: PromotionBuilderPreview['acceptanceCriteria'] = [
    {
      label: 'Catalog has at least 16% protected inventory buffer.',
      passed: draft.inventoryBufferPercent >= 16,
      detail: `Current buffer: ${draft.inventoryBufferPercent}%.`,
    },
    {
      label: 'Checkout complexity stays at or below 48 points.',
      passed: checkoutComplexity <= 48,
      detail: `Current complexity: ${checkoutComplexity}.`,
    },
    {
      label: 'Fulfillment risk stays at or below 42 points.',
      passed: fulfillmentRisk <= 42,
      detail: `Current fulfillment risk: ${fulfillmentRisk}.`,
    },
    {
      label: 'Launch readiness reaches at least 72 before handoff.',
      passed: launchReadiness >= 72,
      detail: `Current readiness: ${launchReadiness}.`,
    },
  ];

  const recommendations: string[] = [];
  if (draft.inventoryBufferPercent < 18) {
    recommendations.push('Raise the inventory buffer to at least 18% before opening the paid burst.');
  }
  if (checkoutComplexity > 40) {
    recommendations.push('Reduce cart complexity by removing one incentive layer or switching to threshold mechanics.');
  }
  if (fulfillmentRisk > 36) {
    recommendations.push('Shift more demand into pickup-heavy coverage or trim the same-day promise for the first drop.');
  }
  if (draft.vipWindowHours < 8) {
    recommendations.push('Give loyalty members a longer preview window so demand ramps before the full launch.');
  }
  if (recommendations.length === 0) {
    recommendations.push('Current draft is balanced enough for weekly launch cadence; keep the live monitor on checkout latency.');
  }

  const launchBrief = {
    title: `${labelForObjective(draft.objective)} / ${labelForMechanic(draft.mechanic)}`,
    summary:
      `${channelPreset.label} channel mix paired with ${fulfillmentPreset.label.toLowerCase()} execution. ` +
      `Projected ${projectedOrders.toLocaleString()} orders with ${averageOrderValueLift}% AOV lift if the draft ships on ${draft.launchDay}.`,
    timeline: [
      `${draft.vipWindowHours}h VIP preview opens before the main drop.`,
      `Paid and onsite amplification follow once the discount reaches ${draft.discountPercent}% with a $${draft.thresholdAmount} threshold.`,
      `Store network covers ${fulfillmentPreset.activeStores} locations with ${fulfillmentPreset.pickupShare}% pickup share.`,
    ],
  };

  const messageLayers = [draft.stackable, draft.autoApply, draft.giftWithPurchase, draft.vipWindowHours > 0].filter(Boolean).length;
  const heroBannerSections: PromotionBuilderPreview['heroBannerChecklist']['sections'] = [
    {
      title: 'Message Hierarchy',
      detail: 'Keep the offer readable before operators open responsive proofs.',
      items: [
        {
          label: 'Headline discount reads as a single focal point.',
          status: resolveStatus(draft.discountPercent >= 12 && draft.discountPercent <= 28, draft.discountPercent >= 10 && draft.discountPercent <= 32),
          detail: `${draft.discountPercent}% headline depth should stay legible without overpowering the brand line.`,
        },
        {
          label: 'Threshold and supporting copy fit in one short subhead.',
          status: resolveStatus(draft.thresholdAmount >= 90 && draft.thresholdAmount <= 160, draft.thresholdAmount >= 75 && draft.thresholdAmount <= 190),
          detail: `$${draft.thresholdAmount} threshold keeps the hero subhead ${draft.thresholdAmount <= 160 ? 'tight' : 'at risk of wrapping'}.`,
        },
      ],
    },
    {
      title: 'Layout Safety',
      detail: 'Visual density should survive mobile crops and badge treatments.',
      items: [
        {
          label: 'CTA is not crowded by stacked promotional labels.',
          status: resolveStatus(messageLayers <= 2, messageLayers <= 3),
          detail: `${messageLayers} active message layer${messageLayers === 1 ? '' : 's'} across VIP, auto-apply, stackable, and gift callouts.`,
        },
        {
          label: 'Mobile crop can hold the price signal and CTA together.',
          status: resolveStatus(checkoutComplexity <= 34 && messageLayers <= 2, checkoutComplexity <= 48 && messageLayers <= 3),
          detail: `Checkout complexity ${checkoutComplexity} indicates ${checkoutComplexity <= 34 ? 'standard' : checkoutComplexity <= 48 ? 'elevated' : 'compressed'} copy density in the hero frame.`,
        },
      ],
    },
    {
      title: 'Publish Sync',
      detail: 'The hero promise has to match inventory and fulfillment reality.',
      items: [
        {
          label: 'Fulfillment language matches the selected delivery posture.',
          status: resolveStatus(fulfillmentRisk <= 28, fulfillmentRisk <= 42),
          detail: `${labelForFulfillmentPreset(draft.fulfillmentPreset)} is carrying a fulfillment risk score of ${fulfillmentRisk}.`,
        },
        {
          label: 'Inventory and compliance footer can publish without escalation.',
          status: resolveStatus(draft.inventoryBufferPercent >= 18 && launchReadiness >= 78, draft.inventoryBufferPercent >= 16 && launchReadiness >= 72),
          detail: `${draft.inventoryBufferPercent}% buffer and readiness ${launchReadiness} determine whether legal and stock caveats stay lightweight.`,
        },
      ],
    },
  ];

  const heroBannerItems = heroBannerSections.flatMap((section) => section.items);
  const readyCount = heroBannerItems.filter((item) => item.status === 'ready').length;
  const watchCount = heroBannerItems.filter((item) => item.status === 'watch').length;
  const blockedCount = heroBannerItems.filter((item) => item.status === 'blocked').length;
  const totalCount = heroBannerItems.length;
  const completionPercent = Math.round((readyCount / totalCount) * 100);
  const heroGateStatus = blockedCount > 0 ? 'blocked' : watchCount > 0 ? 'watch' : 'ready';
  const heroGateSummary =
    heroGateStatus === 'ready'
      ? 'All hero banner checks are clear for the weekly publish lane.'
      : heroGateStatus === 'watch'
        ? `${watchCount} review item${watchCount === 1 ? '' : 's'} should be acknowledged before the banner goes live.`
        : `${blockedCount} blocking item${blockedCount === 1 ? '' : 's'} should be resolved before hero publishing.`;
  const heroGateLabel =
    heroGateStatus === 'ready' ? 'Publish Ready' : heroGateStatus === 'watch' ? 'Review Before Publish' : 'Hold Before Publish';
  const heroAcceptanceCriteria = [
    'Zero blocked checks across message hierarchy, crop safety, and publish sync.',
    'Discount, threshold, and CTA remain readable within the first mobile viewport.',
    'Any watch item is explicitly covered in the weekly launch review before publish.',
    'Fulfillment and inventory promises match the selected operating preset.',
  ];

  return {
    draft,
    presetContext: {
      channels: channelPreset.mix,
      pickupShare: fulfillmentPreset.pickupShare,
      sameDayShare: fulfillmentPreset.sameDayShare,
      shipToHomeShare: 100 - fulfillmentPreset.pickupShare - fulfillmentPreset.sameDayShare,
      activeStores: fulfillmentPreset.activeStores,
    },
    metrics: {
      demandIndex,
      projectedOrders,
      averageOrderValueLift,
      marginPressure,
      checkoutComplexity,
      fulfillmentRisk,
      launchReadiness,
    },
    panels: [
      {
        id: 'campaign',
        title: 'Campaign Posture',
        eyebrow: 'Reach',
        score: `${demandIndex}`,
        detail: `${channelPreset.label} drives ${projectedOrders.toLocaleString()} projected orders with ${draft.discountPercent}% headline depth.`,
      },
      {
        id: 'catalog',
        title: 'Catalog Fit',
        eyebrow: 'Buffer',
        score: `${draft.inventoryBufferPercent}%`,
        detail: `Threshold set at $${draft.thresholdAmount} to defend AOV while leaving room for replenishment pacing.`,
      },
      {
        id: 'checkout',
        title: 'Checkout Load',
        eyebrow: 'Complexity',
        score: `${checkoutComplexity}`,
        detail: `${draft.autoApply ? 'Auto-apply' : 'Manual redemption'} flow with ${draft.stackable ? 'stackable' : 'single'} rule evaluation.`,
      },
      {
        id: 'fulfillment',
        title: 'Fulfillment Envelope',
        eyebrow: 'Risk',
        score: `${fulfillmentRisk}`,
        detail: `${fulfillmentPreset.sameDayShare}% same-day and ${fulfillmentPreset.pickupShare}% pickup share across ${fulfillmentPreset.activeStores} stores.`,
      },
    ],
    guardrails,
    acceptanceCriteria,
    recommendations,
    launchBrief,
    heroBannerChecklist: {
      gate: {
        status: heroGateStatus,
        label: heroGateLabel,
        summary: heroGateSummary,
        completionPercent,
        readyCount,
        watchCount,
        blockedCount,
        totalCount,
      },
      sections: heroBannerSections,
      acceptanceCriteria: heroAcceptanceCriteria,
    },
  };
}

function normalizeDraft(input: Partial<PromotionBuilderDraft>): PromotionBuilderDraft {
  return {
    objective: pickEnum(seed.objectives.map((item) => item.id), input.objective, seed.defaults.objective),
    mechanic: pickEnum(seed.mechanics.map((item) => item.id), input.mechanic, seed.defaults.mechanic),
    discountPercent: clampNumber(input.discountPercent, 5, 35, seed.defaults.discountPercent),
    thresholdAmount: clampNumber(input.thresholdAmount, 60, 220, seed.defaults.thresholdAmount),
    budgetK: clampNumber(input.budgetK, 20, 220, seed.defaults.budgetK),
    inventoryBufferPercent: clampNumber(input.inventoryBufferPercent, 8, 30, seed.defaults.inventoryBufferPercent),
    vipWindowHours: clampNumber(input.vipWindowHours, 0, 36, seed.defaults.vipWindowHours),
    channelPreset: pickEnum(seed.channelPresets.map((item) => item.id), input.channelPreset, seed.defaults.channelPreset),
    fulfillmentPreset: pickEnum(
      seed.fulfillmentPresets.map((item) => item.id),
      input.fulfillmentPreset,
      seed.defaults.fulfillmentPreset
    ),
    launchDay: pickEnum(seed.launchDays, input.launchDay, seed.defaults.launchDay),
    stackable: typeof input.stackable === 'boolean' ? input.stackable : seed.defaults.stackable,
    autoApply: typeof input.autoApply === 'boolean' ? input.autoApply : seed.defaults.autoApply,
    giftWithPurchase:
      typeof input.giftWithPurchase === 'boolean' ? input.giftWithPurchase : seed.defaults.giftWithPurchase,
  };
}

function pickEnum<T extends string>(values: T[], candidate: unknown, fallback: T): T {
  return typeof candidate === 'string' && values.includes(candidate as T) ? (candidate as T) : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  return clamp(Math.round(value), min, max);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function labelForObjective(objective: PromotionObjective): string {
  return seed.objectives.find((item) => item.id === objective)?.label ?? objective;
}

function labelForMechanic(mechanic: PromotionMechanic): string {
  return seed.mechanics.find((item) => item.id === mechanic)?.label ?? mechanic;
}

function labelForFulfillmentPreset(preset: FulfillmentPresetId): string {
  return seed.fulfillmentPresets.find((item) => item.id === preset)?.label ?? preset;
}

function resolveStatus(passed: boolean, warning: boolean): 'ready' | 'watch' | 'blocked' {
  if (passed) {
    return 'ready';
  }
  if (warning) {
    return 'watch';
  }
  return 'blocked';
}
