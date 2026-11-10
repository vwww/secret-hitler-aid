import test from "node:test";
import assert from "node:assert/strict";
import { hashInformationKey, train, trainAll } from "./train-cfr.mjs";

test("uses stable compact information-set fingerprints", () => {
  assert.equal(hashInformationKey('{"seat":1}'), hashInformationKey('{"seat":1}'));
  assert.equal(hashInformationKey('{"seat":1}').length, 32);
});

test("exports normalized average strategies as ordered action arrays", () => {
  const result = train({ players: 5, iterations: 1, maxNodes: 80, random: () => 0.5 });
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.algorithm, "external-sampling-mccfr-agent-form");
  assert.ok(Object.keys(result.policy).length > 0);
  for (const [key, entry] of Object.entries(result.policy)) {
    assert.equal(key.length, 32);
    assert.ok(Array.isArray(entry.actions));
    assert.ok(entry.actions.every((probability) => probability >= 0 && probability <= 1));
    assert.ok(Math.abs(entry.actions.reduce((sum, probability) => sum + probability, 0) - 1) < 1e-8);
  }
});

test("trains multiple player counts concurrently into one policy package", async () => {
  const result = await trainAll({ players: [5, 6], iterations: 1, workers: 2, maxNodes: 40, seed: 7 });
  assert.equal(result.schemaVersion, 3);
  assert.deepEqual(result.players, [5, 6]);
  assert.equal(result.workers, 2);
  assert.ok(result.policies["5"].policy);
  assert.ok(result.policies["6"].policy);
});
