import Fastify from 'fastify';
import { registerPromotionBuilderRoutes } from '../src/routes/promotion-builder';
import { buildPromotionPreview, getPromotionBuilderSeed } from '../src/services/promotion-builder';

describe('Promotion Builder', () => {
  test('should expose a browser entry for campaign operators', async () => {
    const app = Fastify();
    registerPromotionBuilderRoutes(app);

    const response = await app.inject({ method: 'GET', url: '/ops/promotion-builder' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Adaptive Promotion Builder');
    expect(response.body).toContain('Visual publishing checklist');

    await app.close();
  });

  test('should return defaults and a live preview', async () => {
    const app = Fastify();
    registerPromotionBuilderRoutes(app);

    const defaultsResponse = await app.inject({ method: 'GET', url: '/api/campaigns/promotion-builder/defaults' });
    expect(defaultsResponse.statusCode).toBe(200);

    const defaults = defaultsResponse.json();
    expect(defaults.defaults.objective).toBe(getPromotionBuilderSeed().defaults.objective);

    const previewResponse = await app.inject({
      method: 'POST',
      url: '/api/campaigns/promotion-builder/preview',
      payload: {
        ...defaults.defaults,
        objective: 'clearance',
        discountPercent: 28,
        giftWithPurchase: true,
        fulfillmentPreset: 'metro-fast',
      },
    });

    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json();
    expect(preview.metrics.fulfillmentRisk).toBeGreaterThan(20);
    expect(preview.acceptanceCriteria).toHaveLength(4);
    expect(preview.heroBannerChecklist.sections).toHaveLength(3);
    expect(preview.heroBannerChecklist.gate.label).toBeTruthy();
    expect(preview.launchBrief.summary).toContain('Projected');

    await app.close();
  });

  test('should mark overloaded launch scenarios as failing acceptance criteria', () => {
    const preview = buildPromotionPreview({
      objective: 'clearance',
      mechanic: 'tiered',
      discountPercent: 35,
      thresholdAmount: 60,
      budgetK: 220,
      inventoryBufferPercent: 8,
      vipWindowHours: 0,
      fulfillmentPreset: 'metro-fast',
      channelPreset: 'urgent',
      stackable: true,
      autoApply: true,
      giftWithPurchase: true,
    });

    const failedCriteria = preview.acceptanceCriteria.filter((item) => !item.passed);
    expect(failedCriteria.length).toBeGreaterThanOrEqual(2);
    expect(preview.metrics.launchReadiness).toBeLessThan(72);
    expect(preview.heroBannerChecklist.gate.status).toBe('blocked');
    expect(preview.heroBannerChecklist.gate.blockedCount).toBeGreaterThanOrEqual(1);
  });
});
