import test from "node:test";
import assert from "node:assert/strict";
import {
  _kfAncestryRegionFromQuestion,
  _kfCollectAncestryByRegion,
  _kfPlaceMatchesAncestryRegion,
} from "../src/app/82-ancestry-region.js";

test("Irish ancestry questions route to the Ireland region", () => {
  assert.equal(_kfAncestryRegionFromQuestion("tell me about my irish ancestors"), "ireland");
  assert.equal(_kfAncestryRegionFromQuestion("ancestors from Northern Ireland"), "ireland");
});

test("Ireland region includes Northern Ireland and Ulster evidence", () => {
  assert.equal(_kfPlaceMatchesAncestryRegion("Londonderry, Northern Ireland", "ireland"), true);
  assert.equal(_kfPlaceMatchesAncestryRegion("Northern Ireland, United Kingdom", "ireland"), true);
  assert.equal(_kfPlaceMatchesAncestryRegion("Coleraine, Londonderry, Ulster, Ireland", "ireland"), true);
});

test("Ireland region excludes US places named Ireland", () => {
  assert.equal(_kfPlaceMatchesAncestryRegion("Ireland, Taylor, Kentucky, USA", "ireland"), false);
  assert.equal(_kfPlaceMatchesAncestryRegion("Ireland", "ireland"), true);
});

test("Ireland ancestry collection finds direct Aiken ancestors from Northern Ireland", () => {
  globalThis.lastRootId = "root";
  globalThis.lastParentsOf = new Map([
    ["root", ["parent"]],
    ["parent", ["aiken", "kentucky"]],
  ]);
  globalThis.lastIndiById = new Map([
    ["root", { id: "root", name: "Root Person", events: [] }],
    ["parent", { id: "parent", name: "Parent Person", events: [] }],
    ["aiken", {
      id: "aiken",
      name: "John Aiken",
      birth_year: 1780,
      events: [{ type: "BIRT", year: 1780, place: "Londonderry, Northern Ireland" }],
    }],
    ["kentucky", {
      id: "kentucky",
      name: "Taylor Ireland",
      birth_year: 1790,
      events: [{ type: "BIRT", year: 1790, place: "Ireland, Taylor, Kentucky, USA" }],
    }],
  ]);
  globalThis.lastIndividuals = [...lastIndiById.values()];
  globalThis.lastIndiIdxById = new Map(lastIndividuals.map((ind, idx) => [ind.id, idx]));
  globalThis._kfActiveTreeName = "Golden - Rosenberg";
  globalThis.lastFileName = "Golden - Rosenberg";
  globalThis._kfAncestorsByGen = (rootId, parentsOf, maxGen) => {
    const out = new Map([[rootId, 0]]);
    const queue = [[rootId, 0]];
    while (queue.length) {
      const [id, gen] = queue.shift();
      if (gen >= maxGen) continue;
      for (const pid of parentsOf.get(id) || []) {
        if (out.has(pid)) continue;
        out.set(pid, gen + 1);
        queue.push([pid, gen + 1]);
      }
    }
    return out;
  };
  globalThis._kfSurnameOf = name => String(name || "").split(/\s+/).pop() || "";
  globalThis._kfAddCount = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  globalThis._kfTopCountsFromMap = (map, limit) => [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .slice(0, limit);

  const result = _kfCollectAncestryByRegion({ region: "ireland" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ancestors.map(row => row.name), ["John Aiken"]);
  assert.equal(result.ancestors[0].evidence[0].place, "Londonderry, Northern Ireland");
});
