import { expect, test } from '@playwright/test';

/**
 * The ALE-19 done-when, in a browser: **a recorded M1 session plays back visually with no
 * animation overlap bugs.**
 *
 * `recordings/bank/yard-brawl.jsonl` is a real model-driven fight with two deaths in it. The
 * client's `?replay=` mode feeds it through the same transport seam the server uses, so what runs
 * here is the real animation queue, the real scene and the real turn-order strip — the only thing
 * standing in for the server is the transcript of one.
 *
 * `replay.test.ts` already proves the queue's ordering invariants over every diff of this session
 * under node. What only a browser can add is that it renders: no page errors over a whole fight,
 * the strip tracking initiative, and the dead still on screen and marked down at the end.
 */
interface Hooked {
  deliberate: { pending(): number };
}

const RECORDING = 'yard-brawl';

test('a recorded fight plays back through the real renderer', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`/?replay=${RECORDING}`);
  await expect(page.locator('#app canvas')).toBeVisible();
  await expect(page.locator('#hud')).toContainText(`replay ${RECORDING}`);

  // The fight opens out of combat, so there is no turn order yet and the strip says nothing.
  const strip = page.locator('#initiative');
  const chips = strip.locator('.init-chip');

  // Initiative starts partway in; wait for the strip to appear rather than assuming a turn count.
  await expect(strip).toBeVisible({ timeout: 30_000 });
  expect(await chips.count()).toBeGreaterThan(1);
  // Exactly one chip is highlighted at any moment — that is the whole point of the indicator.
  await expect(strip.locator('.init-chip.is-current')).toHaveCount(1);
  await expect(strip.locator('.init-round')).toContainText('round');

  // Let the rest of the session play out, then wait for the animation queue to drain. `pending`
  // reaching 0 and staying there is the "nothing is stuck on screen" half of "no overlap bugs".
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Hooked).deliberate.pending()), {
      timeout: 120_000,
      intervals: [500],
    })
    .toBe(0);

  // Two entities die in this recording. The strip has to show them struck through rather than
  // quietly dropping them out of the order.
  await expect(strip.locator('.init-chip.is-down').first()).toBeVisible({ timeout: 120_000 });
  await expect(strip.locator('.init-chip.is-current')).toHaveCount(1);

  // Floating damage numbers are transient by design: none may survive the queue draining, or one
  // animation has leaked past the end of its own diff.
  await expect(page.locator('.float-number')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
