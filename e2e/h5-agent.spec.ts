import { test, expect } from '@playwright/test';

test.describe('H5 Frontend End-to-End Acceptance (H-01 ~ H-07, U-01 ~ U-06, P-01 ~ P-04, F-03, F-06, O-01 ~ O-03)', () => {
  test('H-01: Mobile 320px/375px/430px has zero horizontal overflow & PC 1440px centers within 430px', async ({
    page,
  }) => {
    for (const width of [320, 375, 430]) {
      await page.setViewportSize({ width, height: 780 });
      await page.goto('/');
      await expect(page.getByTestId('vault-gate')).toBeVisible();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      );
      expect(overflow, `Viewport ${width}px overflowed horizontally`).toBe(false);
    }

    // PC desktop 1440px: H5 container must be <= 430px and centered
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const box = await page.locator('.h5-shell').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(430);
    expect(box!.x).toBeGreaterThan(400);
  });

  test('H-02 / O-01 / O-03: Vault init, persistence across reload, wrong passphrase rejection, zero localStorage plaintext', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    // 1. Initialize encrypted vault with passphrase
    await page.getByTestId('unlock-passphrase-input').locator('input').fill('test_pass_123');
    await page.getByTestId('unlock-btn').click();
    await expect(page.getByTestId('profile-page')).toBeVisible();

    // 2. Fresh vault must start empty/draft without prefilled demo balances (R09)
    await expect(page.getByTestId('summary-deposit')).toContainText('未填写');
    await expect(page.getByTestId('completeness-tag')).toContainText('草稿');

    // Load synthetic demo profile & check local overview
    await page.getByTestId('load-demo-btn').click();
    await expect(page.getByTestId('summary-deposit')).toContainText('25,000.00');
    await expect(page.getByTestId('completeness-tag')).toContainText('可测算');

    // Verify localStorage holds NO plaintext profile data (Pinia is memory-only)
    const lsLength = await page.evaluate(() => window.localStorage.length);
    expect(lsLength).toBe(0);

    // 3. Reload page -> must lock cleanly and require passphrase again (O-03)
    await page.reload();
    await expect(page.getByTestId('vault-gate')).toBeVisible();

    // 4. Wrong passphrase fails safely without revealing data
    await page.getByTestId('unlock-passphrase-input').locator('input').fill('wrong_pass');
    await page.getByTestId('unlock-btn').click();
    await expect(page.getByTestId('unlock-error')).toBeVisible();
    await expect(page.getByTestId('vault-gate')).toBeVisible();

    // 5. Correct passphrase restores profile from IndexedDB
    await page.getByTestId('unlock-passphrase-input').locator('input').fill('test_pass_123');
    await page.getByTestId('unlock-btn').click();
    await expect(page.getByTestId('summary-deposit')).toContainText('25,000.00');
  });

  test('T6 / T7 / H-04 / P-03 / P-04 / F-06: Full H5 planning flow, privacy intercept, CSV import & stale report invalidation', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    // Track real outbound /api requests to ensure NO raw deposit/nickname leaves the browser (H-04 / P-01)
    const outboundBodies: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/') && req.postData()) {
        outboundBodies.push(req.postData()!);
      }
    });

    // Unlock & load synthetic demo
    await page.getByTestId('unlock-passphrase-input').locator('input').fill('e2e_pass_99');
    await page.getByTestId('unlock-btn').click();
    await page.getByTestId('load-demo-btn').click();

    // 1. Go to Transactions -> load & apply sample CSV (T7 / F-03)
    await page.getByTestId('tab-transactions').click();
    await expect(page.getByTestId('transactions-page')).toBeVisible();
    await page.getByTestId('load-sample-csv-btn').click();
    await expect(page.getByTestId('preview-new-count')).toContainText('4');
    await page.getByTestId('apply-csv-btn').click();

    // 2. Go to Planning -> preview outbound safe summary -> authorize & run Agent
    await page.getByTestId('tab-planning').click();
    await expect(page.getByTestId('planning-page')).toBeVisible();
    await page.getByTestId('preview-outbound-btn').click();

    const previewBox = page.getByTestId('outbound-preview-json');
    await expect(previewBox).toBeVisible();
    const previewText = await previewBox.innerText();
    expect(previewText).not.toContain('2500000');
    expect(previewText).not.toContain('合成演示用户');

    await page.getByTestId('confirm-authorize-btn').click();

    // Wait for verified report with locally interpolated ending cash
    await expect(page.getByTestId('verified-report-card')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('report-verdict-tag')).toContainText('本地已核验');
    await expect(page.getByTestId('report-ending-cash')).toContainText('41,000.00');

    // 3. Controlled post-report structured follow-up intent (R01 / P-03)
    await page.getByTestId('followup-intent-explain_cash_buffer_impact').click();
    await page.getByTestId('followup-send-btn').click();
    await expect(page.getByTestId('followup-answer')).toBeVisible({ timeout: 10_000 });

    // 4. Modify local profile -> old report becomes marked stale/invalidated (F-06 / R14)
    await page.getByTestId('tab-profile').click();
    await page.getByTestId('input-deposit').locator('input').fill('30000');
    await page.getByTestId('save-profile-btn').click();

    await page.getByTestId('tab-planning').click();
    await expect(page.getByTestId('stale-report-banner')).toBeVisible();
    await expect(page.getByTestId('followup-card')).toHaveCount(0);

    // 5. Privacy tab audit & revoke authorization (P-04)
    await page.getByTestId('tab-privacy').click();
    await expect(page.getByTestId('provider-mode-tag')).toContainText('Mock Provider');
    await expect(page.getByTestId('auth-status-tag')).toContainText('当前已授权');
    await page.getByTestId('revoke-auth-btn').click();
    await expect(page.getByTestId('auth-status-tag')).toContainText('未授权');

    // 6. Final network audit: zero raw figures/nicknames ever hit /api/
    const joinedOutbound = outboundBodies.join('\n');
    expect(joinedOutbound).not.toContain('2500000');
    expect(joinedOutbound).not.toContain('合成演示用户');
    expect(joinedOutbound).not.toContain('25000');
  });
  test('FIX-08 allows keeping one user-confirmed duplicate while skipping the others', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('unlock-passphrase-input').locator('input').fill('synthetic-duplicates');
    await page.getByTestId('unlock-btn').click();
    await page.getByTestId('load-demo-btn').click();
    await page.getByTestId('tab-transactions').click();
    await page.getByTestId('load-sample-csv-btn').click();
    await page.getByTestId('apply-csv-btn').click();
    await expect(page.getByText('共 4 条', { exact: true })).toBeVisible();
    await page.getByTestId('load-sample-csv-btn').click();
    await page.getByRole('switch', { name: '确为另一笔交易，保留' }).first().click();
    await page.getByTestId('apply-csv-btn').click();
    await expect(page.getByText('共 5 条', { exact: true })).toBeVisible();
  });

});
