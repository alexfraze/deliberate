import { expect, test } from '@playwright/test';

/**
 * Loads the client in fixture mode (no server) and checks the renderer actually came up: a canvas
 * with a real size, a backend reported in the HUD (which only happens after the WebGPU/WebGL
 * renderer finished `init()`), the fixture snapshot rendered, and the scripted diff stream
 * animating a floating damage number.
 */
test('renders the fixture map and animates the scripted diffs', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/?fixture=1');

  const canvas = page.locator('#app canvas');
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((el: HTMLCanvasElement) => ({
    width: el.clientWidth,
    height: el.clientHeight,
  }));
  expect(size.width).toBeGreaterThan(0);
  expect(size.height).toBeGreaterThan(0);

  const hud = page.locator('#hud');
  await expect(hud).toContainText(/webgpu|webgl/);
  await expect(hud).toContainText('3 entities on m0-yard');

  // The scripted turns: a move, then a hit, then a hit back. The float is the damage number.
  await expect(page.locator('.float-number').first()).toBeVisible({ timeout: 15_000 });

  expect(errors).toEqual([]);
});

test('clicking a tile with nothing selected tells the player what to do', async ({ page }) => {
  await page.goto('/?fixture=1');
  const canvas = page.locator('#app canvas');
  await expect(canvas).toBeVisible();
  await expect(page.locator('#hud')).toContainText('3 entities on m0-yard');

  await canvas.click({ position: { x: 40, y: 40 } }); // off the map: clears any selection
  await canvas.click(); // centre of the canvas is over the map
  await expect(page.locator('#hud')).toContainText(/Select an entity first|Selected/);
});
