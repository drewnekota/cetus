import { expect, test, type Page } from '@playwright/test';

// Fixture methods are test-only; the mounted list and controller are production code.
const state = (page: Page) => page.evaluate(() => (window as any).harness.status());
const act = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(({ method, args }) => (window as any).harness[method](...args), { method, args });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect.poll(async () => (await state(page)).distance).toBeLessThanOrEqual(1);
  await page.mouse.move(300, 250);

});

test('streaming, wheel intent, resizing, appending and history restoration', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await act(page, 'start');
  await page.waitForTimeout(400);
  expect((await state(page)).distance).toBeLessThan(35);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, -30);
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(200);
  const paused = await state(page);
  expect(paused.following).toBe(false);
  expect(paused.distance).toBeGreaterThan(250);
  await page.waitForTimeout(400);
  expect(Math.abs((await state(page)).top - paused.top)).toBeLessThanOrEqual(1);
  await act(page, 'shrink');
  await act(page, 'append');
  await page.waitForTimeout(250);
  expect(Math.abs((await state(page)).top - paused.top)).toBeLessThanOrEqual(1);
  await act(page, 'stop');
  await page.mouse.wheel(0, 10000);

  await expect.poll(async () => (await state(page)).following).toBe(true);
  await act(page, 'append');
  await expect.poll(async () => (await state(page)).distance).toBeLessThanOrEqual(1);
  await page.mouse.wheel(0, -4000);
  await page.waitForTimeout(300);
  const saved = await state(page);
  expect(saved.following).toBe(false);
  expect(saved.rendered).toBeLessThan(30);
  await act(page, 'restore');
  await page.waitForTimeout(500);
  expect(Math.abs((await state(page)).top - saved.top)).toBeLessThanOrEqual(2);
  expect((await state(page)).following).toBe(false);
  expect(errors).toEqual([]);
});

test('a tiny upward wheel remains paused through later output and explicit resume', async ({ page }) => {
  await page.mouse.wheel(0, -5);
  await page.waitForTimeout(150);
  expect((await state(page)).following).toBe(false);
  const paused = await state(page);
  await act(page, 'start');
  await page.waitForTimeout(400);
  expect(Math.abs((await state(page)).top - paused.top)).toBeLessThanOrEqual(1);
  await act(page, 'stop');
  await act(page, 'resume');
  await expect.poll(async () => (await state(page)).distance).toBeLessThanOrEqual(1);
  expect((await state(page)).following).toBe(true);
});

test('measurement changes above the viewport preserve the visible message', async ({ page }) => {
  await act(page, 'seek', 80);
  await page.waitForTimeout(400);
  const rowTop = () => page.locator('[data-index="80"]').evaluate(el => el.getBoundingClientRect().top);
  const before = await rowTop();
  await act(page, 'resizeRow', 79, 160);
  await page.waitForTimeout(200);
  expect(Math.abs(await rowTop() - before)).toBeLessThanOrEqual(1);
  await act(page, 'resizeRow', 81, 600);
  await page.waitForTimeout(200);
  expect(Math.abs(await rowTop() - before)).toBeLessThanOrEqual(1);
  expect((await state(page)).following).toBe(false);
});
