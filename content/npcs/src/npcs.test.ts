import {
  assertSnapshot,
  createEngine,
  createStore,
  dialogueLine,
  fixtureSnapshot,
  getWeapon,
  hashSnapshot,
  inBounds,
  isWalkable,
  apply as applyDiffs,
} from '@deliberate/engine';
import type { Direction8, Entity, Intent, Snapshot, Verdict } from '@deliberate/protocol';
import { describe, expect, it } from 'vitest';

import {
  DISPOSITION_MAX,
  DISPOSITION_MIN,
  GATEHOUSE_DOOR,
  GATEHOUSE_MAP_ID,
  GATEHOUSE_PLAYER_ID,
  GATEHOUSE_SEED,
  GUARD,
  GUARD_ID,
  MERCHANT,
  MERCHANT_ID,
  NPC_ARCHETYPES,
  POSTERN_LANE,
  POSTERN_LANE_MAP_ID,
  SCENE,
  SCOUT,
  SCOUT_ID,
  dialogueSeedsFor,
  dialogueSeedsInSnapshot,
  dispositionBand,
  dispositionToward,
  gatehouseMap,
  gatehouseSnapshot,
  posternLaneMap,
  isDisposition,
  npcEntity,
  npcGoals,
} from './index.js';

const DIRECTIONS: readonly Direction8[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function ok(verdict: Verdict): Verdict {
  expect(verdict.ok, verdict.reason).toBe(true);
  return verdict;
}

/** An engine over a fresh gatehouse, with the fixed scene seed so every run rolls the same. */
function gatehouseEngine() {
  return createEngine(gatehouseSnapshot(), { seed: GATEHOUSE_SEED });
}

function entityOf(snapshot: Snapshot, id: string): Entity {
  const e = snapshot.entities[id];
  expect(e, `no entity ${id}`).toBeDefined();
  return e!;
}

// -------------------------------------------------------------------------------------------
// The content loads
// -------------------------------------------------------------------------------------------

describe('gatehouse content', () => {
  it('loads into a valid snapshot the store accepts', () => {
    const snapshot = gatehouseSnapshot();
    expect(() => assertSnapshot(snapshot)).not.toThrow();
    const store = createStore(snapshot);
    expect(store.entityIds()).toEqual(
      [GATEHOUSE_PLAYER_ID, GUARD_ID, MERCHANT_ID, SCOUT_ID].sort(),
    );
    expect(store.hasMap(GATEHOUSE_MAP_ID)).toBe(true);
    expect(store.initiative()).toBeNull();
  });

  it('hands out fresh objects, never a shared reference', () => {
    const a = gatehouseSnapshot();
    const b = gatehouseSnapshot();
    expect(a).toEqual(b);
    entityOf(a, GUARD_ID).components.health!.hp = 1;
    expect(entityOf(b, GUARD_ID).components.health!.hp).toBe(GUARD.health.hp);
  });

  it('carries the three archetypes, one of each kind', () => {
    expect(NPC_ARCHETYPES.map((n) => n.archetype)).toEqual(['guard', 'merchant', 'scout']);
    expect(new Set(NPC_ARCHETYPES.map((n) => n.id)).size).toBe(3);
  });

  it('keeps the M0 fixtures working alongside it', () => {
    const m0 = fixtureSnapshot();
    expect(() => assertSnapshot(m0)).not.toThrow();
    expect(Object.keys(m0.world.maps)).toEqual(['m0-yard']);
    expect(Object.keys(gatehouseSnapshot().world.maps).sort()).toEqual(
      [GATEHOUSE_MAP_ID, POSTERN_LANE_MAP_ID].sort(),
    );
    expect(Object.keys(gatehouseSnapshot({ neighbours: false }).world.maps)).toEqual([
      GATEHOUSE_MAP_ID,
    ]);
    expect(GATEHOUSE_MAP_ID).not.toBe('m0-yard');
  });

  /**
   * The lane is test terrain for `traverse` (ALE-43), and the one thing it has to get right is
   * the pairing: an exit whose far side does not lead back is a one-way door into a room with no
   * handle. Checked here rather than trusted, because both halves are hand-authored JSON.
   */
  it('pairs every exit with a way back', () => {
    const snapshot = gatehouseSnapshot();
    for (const map of Object.values(snapshot.world.maps)) {
      for (const exit of map.exits ?? []) {
        const far = snapshot.world.maps[exit.to];
        expect(far, `${map.id} exits to a map that is not loaded`).toBeDefined();
        const cell = far!.cells[exit.entrance.y * far!.width + exit.entrance.x];
        expect(cell?.walkable, `${map.id} -> ${exit.to} comes out somewhere unwalkable`).toBe(true);
        const back = (far!.exits ?? []).find((e) => e.to === map.id);
        expect(back, `${exit.to} has no way back to ${map.id}`).toBeDefined();
        expect(back!.at).toEqual(exit.entrance);
        expect(back!.entrance).toEqual(exit.at);
        // You leave from somewhere you can stand.
        const from = map.cells[exit.at.y * map.width + exit.at.x];
        expect(from?.walkable, `${map.id} exits from an unwalkable tile`).toBe(true);
      }
    }
  });

  it('authors the postern lane as terrain and nothing else', () => {
    const lane = posternLaneMap();
    expect(lane.id).toBe(POSTERN_LANE_MAP_ID);
    expect(lane.cells).toHaveLength(lane.width * lane.height);
    expect(lane.height).toBe(POSTERN_LANE.rows.length);
    // Nobody lives there: it is somewhere to walk to, and populating it is `spawn`'s job.
    const snapshot = gatehouseSnapshot();
    const onLane = Object.values(snapshot.entities).filter(
      (e) => e.components.position?.map === POSTERN_LANE_MAP_ID,
    );
    expect(onLane).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
// Every reference resolves
// -------------------------------------------------------------------------------------------

describe('references', () => {
  const snapshot = gatehouseSnapshot();
  const ids = new Set(Object.keys(snapshot.entities));

  it.each(NPC_ARCHETYPES.map((n) => [n.id, n] as const))('%s stands on a walkable tile', (_, n) => {
    const map = gatehouseMap();
    expect(inBounds(map, n.placement)).toBe(true);
    expect(isWalkable(map, n.placement)).toBe(true);
    expect(DIRECTIONS).toContain(n.placement.facing);
  });

  it('places everyone on a distinct tile of the one map', () => {
    const tiles = Object.values(snapshot.entities).map((e) => {
      const p = e.components.position!;
      expect(p.map).toBe(GATEHOUSE_MAP_ID);
      return `${p.x},${p.y}`;
    });
    expect(new Set(tiles).size).toBe(tiles.length);
  });

  it.each(NPC_ARCHETYPES.map((n) => [n.id, n] as const))('%s goals resolve', (_, n) => {
    expect(n.goals.length).toBeGreaterThan(0);
    for (const goal of n.goals) {
      expect(goal.text.length, goal.text).toBeLessThanOrEqual(120);
      expect(goal.refs.length).toBeGreaterThan(0);
      for (const ref of goal.refs) expect(ids, goal.text).toContain(ref);
      if (goal.quest !== undefined) expect(snapshot.world.quests).toHaveProperty(goal.quest);
      if (goal.flag !== undefined) expect(snapshot.world.flags).toHaveProperty(goal.flag);
    }
  });

  it.each(NPC_ARCHETYPES.map((n) => [n.id, n] as const))('%s dialogue resolves', (_, n) => {
    expect(n.dialogue.length).toBeGreaterThan(0);
    for (const seed of n.dialogue) {
      expect(ids, seed.text).toContain(seed.toward);
      expect(seed.text.trim()).not.toBe('');
      expect(seed.tags.length).toBeGreaterThan(0);
      expect(isDisposition(seed.minDisposition), seed.text).toBe(true);
      if (seed.maxDisposition !== undefined) {
        expect(isDisposition(seed.maxDisposition), seed.text).toBe(true);
        expect(seed.maxDisposition).toBeGreaterThanOrEqual(seed.minDisposition);
      }
    }
    // The cosmetic component mirrors the authored lines, so a client can show them unchanged.
    expect(npcEntity(n).components.dialogue!.seeds).toEqual(n.dialogue.map((d) => d.text));
  });

  it.each(NPC_ARCHETYPES.map((n) => [n.id, n] as const))('%s dispositions are in range', (_, n) => {
    const toward = Object.entries(n.disposition.toward);
    expect(toward.length).toBeGreaterThan(0);
    for (const [id, value] of toward) {
      expect(ids).toContain(id);
      expect(id).not.toBe(n.id);
      expect(value).toBeGreaterThanOrEqual(DISPOSITION_MIN);
      expect(value).toBeLessThanOrEqual(DISPOSITION_MAX);
      expect(isDisposition(value)).toBe(true);
    }
  });

  it.each(NPC_ARCHETYPES.map((n) => [n.id, n] as const))(
    '%s is fit to fight and be seen',
    (_, n) => {
      expect(n.health.hp).toBeGreaterThan(0);
      expect(n.health.hp).toBeLessThanOrEqual(n.health.maxHp);
      expect(n.stats.speed % 5).toBe(0);
      expect(n.brain.policy).toBe('gm');
      expect(n.portrait.asset).toMatch(/^portraits\/npc\/.+\.png$/);
      // Anything in the inventory that names a weapon must be a weapon the rules know.
      for (const { item } of n.inventory.items) {
        const weapon = getWeapon(item);
        if (weapon) expect(weapon.key).toBe(item);
      }
    },
  );

  it('makes the guard the door', () => {
    expect(GUARD.placement).toMatchObject(GATEHOUSE_DOOR);
    const map = gatehouseMap();
    // The guard's tile is the only gap in the wall that separates the yard from the inner ward.
    const wallRow = SCENE.rows[GATEHOUSE_DOOR.y]!;
    const gaps = [...wallRow].flatMap((ch, x) => (ch === '#' ? [] : [x]));
    expect(gaps).toEqual([GATEHOUSE_DOOR.x]);
    expect(isWalkable(map, GATEHOUSE_DOOR)).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------
// Talked to — every archetype has something to say, and the GM's line folds into state
// -------------------------------------------------------------------------------------------

describe('talked to', () => {
  it.each(NPC_ARCHETYPES.map((n) => [n.id] as const))('%s has a seed at its start', (id) => {
    const snapshot = gatehouseSnapshot();
    const seeds = dialogueSeedsInSnapshot(snapshot, id);
    expect(seeds.length).toBeGreaterThan(0);
    expect(seeds.every((s) => s.toward === GATEHOUSE_PLAYER_ID)).toBe(true);
  });

  it.each(NPC_ARCHETYPES.map((n) => [n.id] as const))('%s speaking is a state no-op', (id) => {
    const before = gatehouseSnapshot();
    const line = dialogueSeedsInSnapshot(before, id)[0]!;
    const after = applyDiffs(before, [dialogueLine(id, line.text, GATEHOUSE_PLAYER_ID)]);
    expect(after).toEqual(before);
    expect(hashSnapshot(after)).toBe(hashSnapshot(before));
  });

  it('keeps prose out of the state hash, so content edits never break a replay', () => {
    const before = gatehouseSnapshot();
    const after = gatehouseSnapshot();
    entityOf(after, MERCHANT_ID).components.dialogue!.seeds = ['rewritten'];
    entityOf(after, MERCHANT_ID).components.portrait!.asset = 'portraits/npc/other.png';
    expect(hashSnapshot(after)).toBe(hashSnapshot(before));
  });

  it('gives the merchant trade and rumour, gated on disposition', () => {
    const tagsAt = (n: number) => dialogueSeedsFor(MERCHANT, n).flatMap((s) => s.tags);
    expect(tagsAt(-60)).toContain('refuse');
    expect(tagsAt(-60)).not.toContain('trade');
    expect(tagsAt(10)).toContain('trade');
    expect(tagsAt(10)).not.toContain('rumour');
    expect(tagsAt(20)).toContain('rumour');
    expect(tagsAt(50)).toContain('discount');
  });

  it('gives the guard a block line at every disposition', () => {
    for (const n of [-100, -50, 0, 50, 100]) {
      expect(dialogueSeedsFor(GUARD, n).flatMap((s) => s.tags)).toContain('block');
    }
  });

  it('gives the scout a quest hook once he trusts the player at all', () => {
    expect(dialogueSeedsFor(SCOUT, 0).flatMap((s) => s.tags)).not.toContain('quest-hook');
    expect(dialogueSeedsFor(SCOUT, 20).flatMap((s) => s.tags)).toContain('quest-hook');
    const quest = SCOUT.goals.find((g) => g.quest)?.quest;
    expect(gatehouseSnapshot().world.quests[quest!]?.step).toBe(0);
  });

  it('exposes goal text per NPC for the memory block', () => {
    const goals = npcGoals();
    expect(Object.keys(goals).sort()).toEqual([GUARD_ID, MERCHANT_ID, SCOUT_ID].sort());
    expect(goals[GUARD_ID]!.join(' ')).toContain(GATEHOUSE_PLAYER_ID);
  });
});

// -------------------------------------------------------------------------------------------
// Fought — every archetype is a legal target and a legal attacker
// -------------------------------------------------------------------------------------------

describe('fought', () => {
  const approach: Record<string, { x: number; y: number }[]> = {
    [GUARD_ID]: [{ x: 6, y: 5 }],
    [MERCHANT_ID]: [{ x: 2, y: 6 }],
    [SCOUT_ID]: [
      { x: 8, y: 9 },
      { x: 9, y: 9 },
    ],
  };

  it.each(NPC_ARCHETYPES.map((n) => [n.id] as const))('the player can fight %s', (id) => {
    const engine = gatehouseEngine();
    for (const to of approach[id]!)
      ok(engine.apply({ kind: 'move', entity: GATEHOUSE_PLAYER_ID, to }));
    const verdict = ok(
      engine.apply({
        kind: 'attack',
        attacker: GATEHOUSE_PLAYER_ID,
        target: id,
        ability: 'longsword',
      }),
    );
    // The first attack opens an encounter with everyone in the yard rolled into initiative.
    expect(verdict.diff[0]).toMatchObject({ type: 'TurnAdvanced' });
    const init = engine.snapshot().initiative;
    expect([...init!.order].sort()).toEqual(
      [GATEHOUSE_PLAYER_ID, GUARD_ID, MERCHANT_ID, SCOUT_ID].sort(),
    );
    expect(init!.order[init!.current]).toBe(GATEHOUSE_PLAYER_ID);
    expect(verdict.diff.some((d) => d.type === 'EconomySpent')).toBe(true);
  });

  it('lets the guard answer a provocation with its own weapon', () => {
    const engine = gatehouseEngine();
    ok(engine.apply({ kind: 'move', entity: GUARD_ID, to: { x: 3, y: 9 } }));
    const verdict = ok(
      engine.apply({
        kind: 'attack',
        attacker: GUARD_ID,
        target: GATEHOUSE_PLAYER_ID,
        ability: 'longsword',
      }),
    );
    expect(verdict.diff.some((d) => d.type === 'TurnAdvanced')).toBe(true);
    expect(engine.snapshot().initiative!.order).toContain(GUARD_ID);
  });

  it('refuses a weapon an NPC is not carrying', () => {
    const engine = gatehouseEngine();
    const verdict = engine.apply({
      kind: 'attack',
      attacker: MERCHANT_ID,
      target: GATEHOUSE_PLAYER_ID,
      ability: 'greataxe',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('greataxe');
  });

  it('leaves the wounded scout prone and easy to finish', () => {
    const scout = entityOf(gatehouseSnapshot(), SCOUT_ID);
    expect(scout.components.health!.conditions).toContain('prone');
    expect(scout.components.health!.hp).toBeLessThan(scout.components.health!.maxHp / 2);
  });

  it('replays the same fight to the same hash from the same seed', () => {
    const intents: Intent[] = [
      { kind: 'move', entity: GATEHOUSE_PLAYER_ID, to: { x: 6, y: 5 } },
      { kind: 'attack', attacker: GATEHOUSE_PLAYER_ID, target: GUARD_ID, ability: 'longsword' },
      { kind: 'end_turn', entity: GATEHOUSE_PLAYER_ID },
    ];
    const run = () => {
      const engine = gatehouseEngine();
      for (const intent of intents) engine.apply(intent);
      return engine.hash();
    };
    expect(run()).toBe(run());
  });
});

// -------------------------------------------------------------------------------------------
// Affected by disposition changes
// -------------------------------------------------------------------------------------------

describe('disposition changes', () => {
  it('swings the merchant from trade to refusal and back', () => {
    const store = createStore(gatehouseSnapshot());
    const set = (value: number) => {
      const current = store.getComponent(MERCHANT_ID, 'disposition')!;
      store.setComponent(MERCHANT_ID, 'disposition', {
        toward: { ...current.toward, [GATEHOUSE_PLAYER_ID]: value },
      });
      return dialogueSeedsInSnapshot(store.snapshot(), MERCHANT_ID).flatMap((s) => s.tags);
    };
    expect(set(-40)).toContain('refuse');
    expect(set(-40)).not.toContain('trade');
    expect(set(60)).toContain('discount');
  });

  it('moves the guard from a bare block to an offer as trust grows', () => {
    const store = createStore(gatehouseSnapshot());
    const at = (value: number) => {
      store.setComponent(GUARD_ID, 'disposition', { toward: { [GATEHOUSE_PLAYER_ID]: value } });
      return dialogueSeedsInSnapshot(store.snapshot(), GUARD_ID).flatMap((s) => s.tags);
    };
    expect(at(-30)).toContain('provoked');
    expect(at(0)).not.toContain('provoked');
    expect(at(0)).not.toContain('offer');
    expect(at(80)).toContain('offer');
  });

  it('reads unknown dispositions as neutral rather than hostile', () => {
    const player = entityOf(gatehouseSnapshot(), GATEHOUSE_PLAYER_ID);
    expect(dispositionToward(player, GUARD_ID)).toBe(0);
    expect(dispositionBand(0)).toBe('neutral');
  });

  it('names every band on the engine scale', () => {
    expect(dispositionBand(DISPOSITION_MIN)).toBe('hostile');
    expect(dispositionBand(-30)).toBe('hostile');
    expect(dispositionBand(-5)).toBe('wary');
    expect(dispositionBand(30)).toBe('friendly');
    expect(dispositionBand(DISPOSITION_MAX)).toBe('trusted');
  });

  it('changes the state hash, because disposition is real state', () => {
    const before = gatehouseSnapshot();
    const store = createStore(before);
    store.setComponent(GUARD_ID, 'disposition', { toward: { [GATEHOUSE_PLAYER_ID]: -80 } });
    expect(hashSnapshot(store.snapshot())).not.toBe(hashSnapshot(before));
  });
});
