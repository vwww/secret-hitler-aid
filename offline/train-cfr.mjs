#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { gzipSync } from "node:zlib";
import { applyAction, createGame, currentPlayer, legalActions, observe, terminalUtility } from "./game-engine.mjs";

function actionKey(action) {
  return JSON.stringify(action);
}

export function informationKey(observation) {
  return JSON.stringify({
    version: 2,
    players: observation.players,
    seat: observation.seat,
    roleKnowledge: Object.entries(observation.knownRoles).sort(([a], [b]) => Number(a) - Number(b)),
    stage: observation.stage,
    president: observation.president,
    lastPresident: observation.lastPresident,
    lastChancellor: observation.lastChancellor,
    chancellor: observation.chancellor,
    liberalPolicies: observation.liberalPolicies,
    fascistPolicies: observation.fascistPolicies,
    electionTracker: observation.electionTracker,
    vetoDenied: observation.vetoDenied,
    eliminated: [...observation.eliminated].sort((a, b) => a - b),
    pendingPower: observation.pendingPower,
    hand: [...observation.hand]
  });
}

export function hashInformationKey(key) {
  let first = 0xcbf29ce484222325n;
  let second = 0x84222325cbf29ce4n;
  for (let index = 0; index < key.length; index++) {
    const code = BigInt(key.charCodeAt(index));
    first = BigInt.asUintN(64, (first ^ code) * 0x100000001b3n);
    second = BigInt.asUintN(64, (second ^ (code + BigInt(index & 255))) * 0x100000001b3n);
  }
  return first.toString(16).padStart(16, "0") + second.toString(16).padStart(16, "0");
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function strategyFor(table, key, actions) {
  const entry = table.get(key);
  const regrets = entry?.regrets ?? new Map();
  const positive = actions.map((action) => Math.max(0, regrets.get(actionKey(action)) ?? 0));
  const total = positive.reduce((sum, value) => sum + value, 0);
  return total ? positive.map((value) => value / total) : actions.map(() => 1 / actions.length);
}

function sampleAction(actions, probabilities, random) {
  let value = random();
  for (let index = 0; index < actions.length; index++) {
    value -= probabilities[index];
    if (value <= 0) return index;
  }
  return actions.length - 1;
}

export function train({ players = 5, iterations = 100, random = Math.random, maxNodes = 3000 } = {}) {
  const table = new Map();
  let visitedNodes = 0;

  function rollout(source, traverser, depth = 0) {
    if (source.stage === "finished") return terminalUtility(source, traverser);
    if (depth >= 80) return 0;
    const actor = currentPlayer(source);
    const actions = legalActions(source);
    if (!actions.length) return 0;
    const key = hashInformationKey(informationKey(observe(source, actor)));
    const probabilities = strategyFor(table, key, actions);
    const selected = sampleAction(actions, probabilities, random);
    return rollout(applyAction(source, actions[selected], { random }), traverser, depth + 1);
  }

  function traverse(source, traverser, ownReach = 1, depth = 0, budget = { nodes: 0 }) {
    if (source.stage === "finished") return terminalUtility(source, traverser);
    if (depth >= 80 || budget.nodes++ >= maxNodes) return rollout(source, traverser, depth);
    visitedNodes += 1;
    const actor = currentPlayer(source);
    const actions = legalActions(source);
    if (!actions.length) return 0;
    const key = hashInformationKey(informationKey(observe(source, actor)));
    const probabilities = strategyFor(table, key, actions);

    if (actor !== traverser) {
      const selected = sampleAction(actions, probabilities, random);
      return traverse(applyAction(source, actions[selected], { random }), traverser, ownReach, depth + 1, budget);
    }

    const values = actions.map((action, index) => traverse(
      applyAction(source, action, { random }), traverser, ownReach * probabilities[index], depth + 1, budget
    ));
    const expected = values.reduce((sum, value, index) => sum + value * probabilities[index], 0);
    let entry = table.get(key);
    if (!entry) {
      entry = { regrets: new Map(), strategySum: new Map(), actionKeys: actions.map(actionKey), visits: 0 };
      table.set(key, entry);
    }
    entry.visits += 1;
    actions.forEach((action, index) => {
      const name = actionKey(action);
      entry.regrets.set(name, (entry.regrets.get(name) ?? 0) + values[index] - expected);
      entry.strategySum.set(name, (entry.strategySum.get(name) ?? 0) + ownReach * probabilities[index]);
    });
    return expected;
  }

  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let traverser = 1; traverser <= players; traverser++) {
      const game = createGame(players, { random });
      traverse(game, traverser);
    }
  }

  const policy = {};
  for (const [key, entry] of table) {
    const weights = entry.actionKeys.map((action) => entry.strategySum.get(action) ?? 0);
    const total = weights.reduce((sum, value) => sum + value, 0);
    policy[key] = {
      actions: total ? weights.map((weight) => weight / total) : weights.map(() => 1 / weights.length),
      visits: entry.visits
    };
  }
  return {
    schemaVersion: 2,
    algorithm: "external-sampling-mccfr-agent-form",
    keyAlgorithm: "dual-fnv1a-128-v1",
    abstraction: "seat-local observation without full action history",
    objective: "shared win/loss utility within liberal and fascist teams",
    players,
    iterations,
    visitedNodes,
    policy
  };
}

async function trainWorker(parameters) {
  return new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: parameters });
    worker.once("message", resolveWorker);
    worker.once("error", rejectWorker);
    worker.once("exit", (code) => {
      if (code !== 0) rejectWorker(new Error(`Training worker exited with code ${code}.`));
    });
  });
}

export async function trainAll({ players = [5, 6, 7, 8, 9, 10], iterations = 25, workers = Math.max(1, cpus().length - 1), maxNodes = 3000, seed = 1 } = {}) {
  if (!Array.isArray(players) || !players.length || players.some((count) => !Number.isInteger(count) || count < 5 || count > 10)) {
    throw new RangeError("Players must be a non-empty list from 5 through 10.");
  }
  if (new Set(players).size !== players.length) throw new Error("Player counts must not repeat.");
  if (!Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(workers) || workers < 1) throw new RangeError("Iterations and workers must be positive integers.");
  const results = new Array(players.length);
  let nextJob = 0;
  const workerCount = Math.min(workers, players.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextJob < players.length) {
      const index = nextJob++;
      const count = players[index];
      results[index] = await trainWorker({ players: count, iterations, maxNodes, seed: seed + count * 1009 });
    }
  }));
  return {
    schemaVersion: 3,
    algorithm: "external-sampling-mccfr-agent-form",
    keyAlgorithm: "dual-fnv1a-128-v1",
    abstraction: "seat-local observation without full action history",
    objective: "shared win/loss utility within liberal and fascist teams",
    players,
    iterationsPerPlayerCount: iterations,
    workers: workerCount,
    policies: Object.fromEntries(results.map((result) => [String(result.players), {
      iterations: result.iterations,
      visitedNodes: result.visitedNodes,
      policy: result.policy
    }]))
  };
}

if (!isMainThread) {
  parentPort.postMessage(train({
    players: workerData.players,
    iterations: workerData.iterations,
    maxNodes: workerData.maxNodes,
    random: seededRandom(workerData.seed)
  }));
} else if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = new Map(process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  }));
  const iterations = Number(args.get("iterations") ?? 25);
  const playerArgument = args.get("players") ?? "all";
  const players = playerArgument === "all" ? [5, 6, 7, 8, 9, 10] : playerArgument.split(",").map(Number);
  const workers = Number(args.get("workers") ?? Math.max(1, cpus().length - 1));
  const maxNodes = Number(args.get("max-nodes") ?? 3000);
  const output = args.get("output") ?? "strategy.json.gz";
  if (!Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(workers) || workers < 1 || !Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new Error("Usage: node offline/train-cfr.mjs --players=all --iterations=25 --workers=4 --output=strategy.json");
  }
  const result = await trainAll({ players, iterations, workers, maxNodes });
  const serialized = Buffer.from(`${JSON.stringify(result)}\n`, "utf8");
  await writeFile(output, output.endsWith(".gz") ? gzipSync(serialized, { level: 9 }) : serialized);
  const informationSets = Object.values(result.policies).reduce((sum, item) => sum + Object.keys(item.policy).length, 0);
  console.log(`Wrote ${informationSets} information sets for ${players.length} player counts to ${output} using ${result.workers} workers.`);
}
