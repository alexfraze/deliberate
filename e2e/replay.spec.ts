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

/**
 * The ALE-35 done-when, in a browser: **conversations with the three archetypes read as dialogue,
 * not logs.**
 *
 * `recordings/bank/parley.jsonl` is the measured case — 34 `DialogueLine` diffs in ten player
 * turns, with all three gatehouse archetypes in it — and it plays through the real render path
 * with no server and no model, so this costs nothing to run. What a test can check is the
 * structure that makes it dialogue rather than a log: lines attributed to distinct speakers, the
 * player's own side of it present, and the preview loop's restatements collapsed rather than said
 * twice. Whether it *looks* like a conversation is a judgement made by looking.
 */
test('a recorded parley reads as attributed dialogue', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?replay=parley');
  await expect(page.locator('#app canvas')).toBeVisible();

  // Hidden until somebody speaks: an empty transcript is not worth a region.
  const thread = page.locator('#dialogue');
  await expect(thread).toBeVisible({ timeout: 30_000 });

  // The replay drains its queue between turns, so "nothing pending" is not "the session is over".
  // Wait on the conversation itself instead: 34 lines were spoken, and the thread settles at 27.
  await expect
    .poll(() => thread.locator('.dl-line').count(), { timeout: 120_000, intervals: [500] })
    .toBeGreaterThanOrEqual(25);

  // Read the whole shape in one go: lines keep arriving, and two separate counts would race.
  const shape = await page.evaluate(() => {
    const lines = [...document.querySelectorAll('#dialogue .dl-line')];
    const nameOf = (node: Element): string =>
      node.querySelector('.dl-who')?.firstChild?.textContent ?? '';
    return {
      lines: lines.length,
      named: lines.filter((node) => nameOf(node) !== '').length,
      portraits: lines.filter((node) => node.querySelector('.dl-portrait') !== null).length,
      self: lines.filter((node) => node.classList.contains('is-self')).length,
      speakers: new Set(lines.map(nameOf)).size,
    };
  });

  // Meaningfully shorter than the diff stream, because the restatements a preview and its GO
  // produce are merged — and not by much, because the conversation itself is all still there.
  expect(shape.lines).toBeLessThan(34);
  // Attribution, which is the whole difference from the old narration box: every line names who
  // said it and carries a portrait slot, and this recording has three archetypes plus the player.
  expect(shape.named).toBe(shape.lines);
  expect(shape.portraits).toBe(shape.lines);
  expect(shape.speakers).toBeGreaterThanOrEqual(4);
  // A conversation has two sides: the player's lines are in the thread and drawn as their own.
  expect(shape.self).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
});
