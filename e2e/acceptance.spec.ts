import { execFileSync } from 'node:child_process';

import { expect, test, type Page } from '@playwright/test';

import { REPLAY_CLI } from './paths.js';

/**
 * M0 acceptance (ALE-13): play by UI alone.
 *
 * One Chromium, the real client, the real server, the real engine, no model in the loop. The suite
 * clicks the canvas the way a player does — it never sends an intent itself — then checks that the
 * session the server recorded replays through a fresh engine to the same hash the browser saw.
 *
 * The run is deterministic: the server boots the M0 fixture with FIXTURE_SEED, so the refusals and
 * the damage roll below are fixed numbers rather than "something happened".
 */

interface Point {
  x: number;
  y: number;
}

/** The read-only hook `packages/client/src/main.ts` publishes for this suite. */
interface AcceptanceHook {
  screenOfEntity(id: string): Point | null;
  screenOfTile(tile: Point): Point | null;
  pending(): number;
  hash(): string;
}

type Hooked = { deliberate: AcceptanceHook };

const PLAYER = 'player';
const DUMMY_A = 'dummy-a';

function hud(page: Page) {
  return page.locator('#hud');
}

async function screenOfEntity(page: Page, id: string): Promise<Point> {
  const point = await page.evaluate(
    (entity) => (window as unknown as Hooked).deliberate.screenOfEntity(entity),
    id,
  );
  expect(point, `entity ${id} is not on screen`).not.toBeNull();
  return point!;
}

async function screenOfTile(page: Page, tile: Point): Promise<Point> {
  const point = await page.evaluate(
    (t) => (window as unknown as Hooked).deliberate.screenOfTile(t),
    tile,
  );
  expect(point, `tile (${tile.x}, ${tile.y}) is not on screen`).not.toBeNull();
  return point!;
}

/** Clicks the canvas at a point in CSS pixels — the same event a player's mouse produces. */
async function clickAt(page: Page, point: Point): Promise<void> {
  await page.locator('#app canvas').click({ position: point });
}

/** Waits for the animation queue to drain, so the HUD has caught up with every diff received. */
async function settle(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Hooked).deliberate.pending()))
    .toBe(0);
}

test('play the M0 fixture by UI alone, then replay the recording', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // --- join ------------------------------------------------------------------------------------
  await page.goto('/');
  await expect(page.locator('#app canvas')).toBeVisible();
  await expect(hud(page)).toContainText('3 entities on m0-yard');
  await expect(hud(page)).toContainText('server live');
  // Out of combat there is no turn order, and the HUD says so.
  await expect(hud(page)).toContainText('exploration — no encounter');

  // --- select the player -----------------------------------------------------------------------
  await clickAt(page, await screenOfEntity(page, PLAYER));
  await expect(hud(page)).toContainText('Player (party) · 12/12 hp · (2, 2)');

  // --- an illegal move is refused, with a reason on screen --------------------------------------
  // (3, 4) is a pillar. The engine is the only thing that decides this; the client just asks.
  await clickAt(page, await screenOfTile(page, { x: 3, y: 4 }));
  await expect(hud(page)).toContainText('refused: (3, 4) cannot be walked on.');
  await expect(hud(page)).toContainText('(2, 2)'); // the player did not move

  // --- a legal move ----------------------------------------------------------------------------
  await clickAt(page, await screenOfTile(page, { x: 7, y: 3 }));
  await settle(page);
  await expect(hud(page)).toContainText('Player (party) · 12/12 hp · (7, 3)');

  // --- attack the dummy ------------------------------------------------------------------------
  await clickAt(page, await screenOfEntity(page, DUMMY_A));
  // A hit for 8 under the fixture seed: the floating number is the damage animation playing.
  await expect(page.locator('.float-number')).toHaveText('-8');
  await settle(page);
  // The turn line is driven entirely by the TurnAdvanced and EconomySpent diffs the attack emitted.
  await expect(hud(page)).toContainText(
    'Player · round 1 · moved 0 ft · action spent · bonus ready',
  );

  // --- the action economy is enforced ----------------------------------------------------------
  await clickAt(page, await screenOfEntity(page, DUMMY_A));
  await expect(hud(page)).toContainText('refused: Player has already used their action this turn');

  // --- the dummy took the damage ---------------------------------------------------------------
  await clickAt(page, await screenOfEntity(page, PLAYER)); // deselect
  await clickAt(page, await screenOfEntity(page, DUMMY_A));
  await expect(hud(page)).toContainText('Training Dummy A (dummies) · 2/10 hp');

  expect(pageErrors).toEqual([]);

  // --- replay the session the server recorded ---------------------------------------------------
  // The server names the file it is writing on /healthz, which the client proxies.
  const health = (await (await page.request.get('/healthz')).json()) as {
    recording: string | null;
  };
  expect(health.recording).toMatch(/\.jsonl$/);
  const recording = health.recording!;

  const output = execFileSync(process.execPath, [REPLAY_CLI, 'replay', recording], {
    encoding: 'utf8',
  });
  // `ok <file>: N turn(s) replayed to <hash>` — the CLI exits non-zero on any divergence, so
  // reaching this line already means every recorded hash matched.
  const replayed = /replayed to ([0-9a-f]{128})/.exec(output)?.[1];
  expect(replayed, output).toBeDefined();

  const seenInBrowser = await page.evaluate(() => (window as unknown as Hooked).deliberate.hash());
  expect(replayed).toBe(seenInBrowser);
});
