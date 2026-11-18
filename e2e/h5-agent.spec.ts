import { test, expect, type Page } from '@playwright/test';

async function initialize(page: Page, expenses = '') {
  await page.goto('/');
  await expect(page.getByTestId('profile-page')).toBeVisible();
  await page.getByTestId('input-nickname').locator('input').fill('合成聊天用户');
  await page.getByTestId('input-deposit').locator('input').fill('50000');
  await page.getByTestId('input-income').locator('input').fill('15000');
  if (expenses) await page.getByTestId('input-expenses').locator('input').fill(expenses);
  await page.getByRole('radio', { name: '无贷款', exact: false }).click();
  await page.getByTestId('setup-passphrase').locator('input').fill('synthetic-chat-password');
  await page.getByTestId('save-profile-btn').click();
  await expect(page.getByTestId('chat-page')).toBeVisible();
}
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: '聊天消息' }).fill(text);
  await page.getByRole('button', { name: '发送消息' }).click();
}

test.describe('初始化后直接聊天', () => {
  test('手机无横向溢出，PC 仍为居中的 H5 页面', async ({ page }) => {
    for (const width of [320, 375, 430]) {
      await page.setViewportSize({ width, height: 780 });
      await page.goto('/');
      await expect(page.getByTestId('profile-page')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const box = await page.locator('.h5-shell').boundingBox();
    expect(box?.width).toBeLessThanOrEqual(430);
    expect(box?.x).toBeGreaterThan(400);
  });

  test('首次保存即聊天，刷新需解锁并恢复本地资料', async ({ page }) => {
    await initialize(page, '5000');
    await expect(page.getByRole('heading', { name: '合成聊天用户，想聊点什么？' })).toBeVisible();
    await expect(page.getByTestId('tab-transactions')).toHaveCount(0);
    await expect(page.getByTestId('tab-planning')).toHaveCount(0);
    expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
    await page.reload();
    await expect(page.getByTestId('vault-gate')).toBeVisible();
    await page.getByTestId('unlock-passphrase-input').locator('input').fill('wrong-password');
    await page.getByTestId('unlock-btn').click();
    await expect(page.getByTestId('unlock-error')).toBeVisible();
    await page.getByTestId('unlock-passphrase-input').locator('input').fill('synthetic-chat-password');
    await page.getByTestId('unlock-btn').click();
    await expect(page.getByTestId('chat-page')).toBeVisible();
    await page.getByRole('button', { name: '资料', exact: true }).click();
    await expect(page.getByTestId('input-deposit').locator('input')).toHaveValue('50000');
    await expect(page.getByText('暂不清楚', { exact: true })).toHaveCount(0);
    await expect(page.getByText('发薪日', { exact: true })).toHaveCount(0);
  });

  test('对话补问、连续追问、脱敏出站、撤销授权与聊天恢复', async ({ page }) => {
    const outbound: string[] = [];
    page.on('request', req => {
      if (req.url().includes('/api/') && req.postData()) outbound.push(req.postData()!);
    });
    await initialize(page);
    await send(page, '买一辆20万的车，我现在负担得起吗？');
    await page.getByRole('button', { name: '同意并继续' }).click();
    await expect(page.getByText(/你每月自己承担的生活开销大概多少/)).toBeVisible();
    await send(page, '每月5000元');
    await expect(page.locator('.chat-history')).toContainText('165,000元', { timeout: 15_000 });
    await send(page, '那一年后买呢');
    await expect(page.locator('.chat-history')).toContainText('45,000元', { timeout: 15_000 });
    await expect(page.locator('.chat-history')).toContainText('12个月后');
    await page.getByRole('button', { name: '隐私', exact: true }).click();
    await page.getByTestId('revoke-auth-btn').click();
    await expect(page.getByTestId('auth-status-tag')).toContainText('未授权');
    await page.reload();
    await page.getByTestId('unlock-passphrase-input').locator('input').fill('synthetic-chat-password');
    await page.getByTestId('unlock-btn').click();
    await expect(page.locator('.chat-history')).toContainText('45,000元');
    const body = outbound.join('\n');
    expect(body).toContain('[金额:amount_1]');
    for (const privateValue of ['合成聊天用户', '20万', '200000', '50000', '15000', '每月5000']) {
      expect(body).not.toContain(privateValue);
    }
    await send(page, '继续解释一下');
    await expect(page.getByRole('button', { name: '同意并继续' })).toBeVisible();
  });
});
