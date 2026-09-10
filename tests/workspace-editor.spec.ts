import { expect, test, type Page } from '@playwright/test';
const act = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(({ method, args }) => (window as any).harness[method](...args), { method, args });
const editor = (page: Page) => page.getByTestId('workspace-text-editor');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(editor(page)).toHaveValue('VALUE=old\n');
});

test('dotfile edits survive selection and remount, shortcut saves with original line endings', async ({ page }) => {
  await editor(page).fill('VALUE=new\n');
  await act(page, 'select', '/repo/LICENSE');
  await expect(editor(page)).toHaveValue('License\n');
  await act(page, 'select', '/repo/.env.local');
  await expect(editor(page)).toHaveValue('VALUE=new\n');
  await act(page, 'mount', false);
  await expect(editor(page)).toHaveCount(0);
  await act(page, 'mount', true);
  await expect(editor(page)).toHaveValue('VALUE=new\n');
  await editor(page).press('Control+s');
  await expect.poll(async () => (await act(page, 'disk'))['/repo/.env.local']).toBe('VALUE=new\r\n');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('conflict preserves edits; reload can be canceled or discard explicitly', async ({ page }) => {
  await editor(page).fill('my edit');
  await act(page, 'externalEdit', '/repo/.env.local', 'external edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('changed on disk');
  await expect(editor(page)).toHaveValue('my edit');
  expect((await act(page, 'disk'))['/repo/.env.local']).toBe('external edit');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(editor(page)).toHaveValue('my edit');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(editor(page)).toHaveValue('external edit');
  await editor(page).fill('reconciled');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await act(page, 'disk'))['/repo/.env.local']).toBe('reconciled');
});

test('typing during a save stays dirty, including after switching away and back', async ({ page }) => {
  await act(page, 'delay', 800);
  await editor(page).fill('first edit');
  await editor(page).press('Meta+s');
  await editor(page).fill('second edit');
  await act(page, 'select', '/repo/LICENSE');
  await expect(editor(page)).toHaveValue('License\n');
  await act(page, 'select', '/repo/.env.local');
  await expect(editor(page)).toHaveValue('second edit');
  await expect.poll(async () => (await act(page, 'disk'))['/repo/.env.local']).toBe('first edit');
  await expect(editor(page)).toHaveValue('second edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await act(page, 'disk'))['/repo/.env.local']).toBe('second edit');
});

test('reverting to original while a save is pending remains an unsaved change afterward', async ({ page }) => {
  await act(page, 'delay', 500);
  await editor(page).fill('submitted');
  await editor(page).press('Control+s');
  await editor(page).fill('VALUE=old\n');
  await expect.poll(async () => (await act(page, 'disk'))['/repo/.env.local']).toBe('submitted');
  await expect(editor(page)).toHaveValue('VALUE=old\n');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await act(page, 'disk'))['/repo/.env.local']).toBe('VALUE=old\r\n');
});
