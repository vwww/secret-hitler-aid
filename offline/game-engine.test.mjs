import test from "node:test";
import assert from "node:assert/strict";
import { applyAction, createGame, currentPlayer, eligibleChancellors, legalActions, observe, terminalUtility } from "./game-engine.mjs";

function castVotes(game, votes) {
  let current = game;
  for (const vote of votes) current = applyAction(current, { type: "vote", vote });
  return current;
}

const rolesFor = (roles) => roles;

test("creates standard role counts for 5 and 7 players", () => {
  const five = createGame(5, { roles: rolesFor(["liberal", "liberal", "liberal", "fascist", "hitler"]) });
  const seven = createGame(7, { roles: rolesFor(["liberal", "liberal", "liberal", "liberal", "fascist", "fascist", "hitler"]) });
  assert.equal(five.roles.filter((role) => role === "liberal").length, 3);
  assert.equal(seven.roles.filter((role) => role === "fascist").length, 2);
});

test("keeps hidden roles private with correct fascist knowledge", () => {
  const five = createGame(5, { roles: ["liberal", "liberal", "liberal", "fascist", "hitler"] });
  assert.deepEqual(observe(five, 4).knownRoles, { 4: "fascist", 5: "hitler" });
  assert.deepEqual(observe(five, 5).knownRoles, { 5: "hitler" });
  const seven = createGame(7, { roles: ["liberal", "liberal", "liberal", "liberal", "fascist", "fascist", "hitler"] });
  assert.deepEqual(observe(seven, 5).knownRoles, { 5: "fascist", 6: "fascist", 7: "hitler" });
  assert.deepEqual(observe(seven, 7).knownRoles, { 7: "hitler" });
});

test("allows previous president after five players remain", () => {
  const game = createGame(6, { roles: ["liberal", "liberal", "liberal", "liberal", "fascist", "hitler"] });
  game.eliminated = [6];
  game.president = 1;
  game.lastPresident = 2;
  game.lastChancellor = 3;
  assert.deepEqual(eligibleChancellors(game), [2, 4, 5]);
});

test("passes a government and records all revealed ballots", () => {
  const game = createGame(5, { roles: ["liberal", "liberal", "liberal", "fascist", "hitler"], deck: Array(28).fill("liberal") });
  const nominated = applyAction(game, { type: "nominate", chancellor: 2 });
  assert.equal(legalActions(nominated).length, 2);
  assert.equal(currentPlayer(nominated), 1);
  const firstVote = applyAction(nominated, { type: "vote", vote: "yes" });
  assert.equal(observe(firstVote, 2).history.length, 0);
  const passed = castVotes(firstVote, ["yes", "yes", "no", "no"]);
  assert.equal(passed.stage, "president-discard");
  assert.equal(passed.history[0].passed, true);
  assert.deepEqual(passed.history[0].votes, { 1: "yes", 2: "yes", 3: "yes", 4: "no", 5: "no" });
  assert.deepEqual(passed.pendingCards, ["liberal", "liberal", "liberal"]);
});

test("three failed elections top-deck and reset term limits", () => {
  const game = createGame(5, { roles: ["liberal", "liberal", "liberal", "fascist", "hitler"], deck: Array(28).fill("liberal") });
  let current = game;
  for (let election = 0; election < 3; election++) {
    const chancellor = eligibleChancellors(current)[0];
    current = applyAction(current, { type: "nominate", chancellor });
    current = castVotes(current, Array(5).fill("no"));
  }
  assert.equal(current.stage, "nomination");
  assert.equal(current.electionTracker, 0);
  assert.equal(current.liberalPolicies, 1);
  assert.equal(current.lastPresident, 0);
  assert.equal(current.lastChancellor, 0);
});

test("enacts the chancellor policy from the actual pending hand", () => {
  const deck = ["liberal", "liberal", "fascist", ...Array(25).fill("liberal")];
  let game = createGame(5, { roles: ["liberal", "liberal", "liberal", "fascist", "hitler"], deck });
  game = applyAction(game, { type: "nominate", chancellor: 2 });
  game = castVotes(game, Array(5).fill("yes"));
  game = applyAction(game, { type: "discard", index: 2 });
  game = applyAction(game, { type: "enact", index: 0 });
  assert.equal(game.liberalPolicies, 1);
  assert.equal(game.stage, "nomination");
});

test("exposes legal choices and opposite team utilities", () => {
  const game = createGame(5, { roles: ["liberal", "liberal", "liberal", "fascist", "hitler"] });
  assert.deepEqual(legalActions(game), eligibleChancellors(game).map((chancellor) => ({ type: "nominate", chancellor })));
  game.stage = "finished";
  game.winner = "liberal";
  assert.equal(terminalUtility(game, 1), 1);
  assert.equal(terminalUtility(game, 4), -1);
});

test("keeps investigation results private to the investigating president", () => {
  const game = createGame(7, { roles: ["liberal", "liberal", "liberal", "liberal", "fascist", "fascist", "hitler"] });
  game.stage = "power";
  game.president = 1;
  game.pendingPower = "investigate";
  const investigated = applyAction(game, { type: "power", target: 7 });
  assert.equal(observe(investigated, 1).knownRoles[7], "fascist");
  assert.equal(observe(investigated, 2).knownRoles[7], undefined);
});

test("uses the original board size for fascist powers after executions", () => {
  const game = createGame(7, { roles: ["liberal", "liberal", "liberal", "liberal", "fascist", "fascist", "hitler"] });
  game.stage = "chancellor-policy";
  game.president = 1;
  game.chancellor = 2;
  game.fascistPolicies = 1;
  game.pendingCards = ["fascist", "liberal"];
  game.eliminated = [3, 4];
  const enacted = applyAction(game, { type: "enact", index: 0 });
  assert.equal(enacted.fascistPolicies, 2);
  assert.equal(enacted.pendingPower, "investigate");
  assert.equal(enacted.stage, "power");
});
