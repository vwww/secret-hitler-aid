const LIBERAL = "liberal";
const FASCIST = "fascist";

function shuffled(items, random = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function roleCounts(players) {
  const fascists = players <= 6 ? 1 : players <= 8 ? 2 : 3;
  return { liberal: players - fascists - 1, fascist: fascists, hitler: 1 };
}

export function createGame(players, { random = Math.random, roles, deck } = {}) {
  if (!Number.isInteger(players) || players < 5 || players > 10) throw new RangeError("Players must be 5 through 10.");
  const counts = roleCounts(players);
  const dealtRoles = roles ? [...roles] : shuffled([
    ...Array(counts.liberal).fill(LIBERAL),
    ...Array(counts.fascist).fill(FASCIST),
    "hitler"
  ], random);
  if (dealtRoles.length !== players || Object.entries(counts).some(([role, count]) => dealtRoles.filter((item) => item === role).length !== count)) {
    throw new Error("Roles do not match the standard role distribution.");
  }
  const policies = deck ? [...deck] : shuffled([...Array(17).fill(LIBERAL), ...Array(11).fill(FASCIST)], random);
  if (policies.some((policy) => policy !== LIBERAL && policy !== FASCIST)) throw new Error("Deck contains an invalid policy.");
  return {
    players,
    roles: dealtRoles,
    drawPile: policies,
    discardPile: [],
    liberalPolicies: 0,
    fascistPolicies: 0,
    electionTracker: 0,
    president: 1,
    votingOrder: [],
    votingIndex: 0,
    pendingVotes: {},
    lastPresident: 0,
    lastChancellor: 0,
    chancellor: 0,
    eliminated: [],
    specialReturn: 0,
    pendingPower: "",
    pendingCards: [],
    privateObservations: {},
    vetoDenied: false,
    stage: "nomination",
    winner: "",
    history: []
  };
}

export function eligibleChancellors(game) {
  const living = Array.from({ length: game.players }, (_, index) => index + 1)
    .filter((seat) => !game.eliminated.includes(seat));
  return living.filter((seat) => seat !== game.president && seat !== game.lastChancellor &&
    (living.length === 5 || seat !== game.lastPresident));
}

export function observe(game, seat) {
  if (seat < 1 || seat > game.players) throw new RangeError("Invalid seat.");
  const role = game.roles[seat - 1];
  const knownRoles = { [seat]: role };
  if (role === FASCIST) {
    game.roles.forEach((otherRole, index) => {
      if (otherRole !== LIBERAL) knownRoles[index + 1] = otherRole;
    });
  }
  for (const observation of game.privateObservations[seat] ?? []) {
    knownRoles[observation.target] = observation.party;
  }
  return {
    players: game.players,
    seat,
    currentActor: currentPlayer(game),
    knownRoles,
    president: game.president,
    lastPresident: game.lastPresident,
    lastChancellor: game.lastChancellor,
    chancellor: game.chancellor,
    liberalPolicies: game.liberalPolicies,
    fascistPolicies: game.fascistPolicies,
    electionTracker: game.electionTracker,
    vetoDenied: game.vetoDenied,
    eliminated: [...game.eliminated],
    stage: game.stage,
    pendingPower: game.pendingPower,
    hand: game.stage === "president-discard" && seat === game.president
      ? [...game.pendingCards]
      : game.stage === "chancellor-policy" && seat === game.chancellor
        ? [...game.pendingCards]
        : [],
    privateObservations: [...(game.privateObservations[seat] ?? [])],
    history: game.history.map((item) => ({ ...item }))
  };
}

function livingSeats(game) {
  return Array.from({ length: game.players }, (_, index) => index + 1)
    .filter((seat) => !game.eliminated.includes(seat));
}

export function currentPlayer(game) {
  if (game.stage === "vote") return game.votingOrder[game.votingIndex] ?? 0;
  if (game.stage === "nomination" || game.stage === "president-discard" || game.stage === "power") return game.president;
  if (game.stage === "chancellor-policy") return game.chancellor;
  if (game.stage === "veto-decision") return game.president;
  return 0;
}

function reshuffleDiscard(game, random) {
  if (game.drawPile.length >= 3) return;
  game.drawPile = shuffled([...game.drawPile, ...game.discardPile], random);
  game.discardPile = [];
}

function nextPresident(game) {
  const current = game.specialReturn || game.president;
  game.president = livingSeats(game).find((seat) => seat > current) ?? livingSeats(game)[0];
  game.specialReturn = 0;
  game.chancellor = 0;
  game.pendingCards = [];
  game.pendingPower = "";
  game.vetoDenied = false;
  game.stage = "nomination";
}

function resolveFailedElection(game, random) {
  game.electionTracker += 1;
  game.history.push({ type: "election-failed", president: game.president, chancellor: game.chancellor });
  if (game.electionTracker >= 3) {
    game.lastPresident = 0;
    game.lastChancellor = 0;
    reshuffleDiscard(game, random);
    const policy = game.drawPile.shift();
    if (!policy) throw new Error("No policy available for the top-deck election.");
    if (policy === LIBERAL) game.liberalPolicies += 1;
    else game.fascistPolicies += 1;
    game.history.push({ type: "top-deck", policy });
    game.electionTracker = 0;
    if (game.liberalPolicies >= 5) game.winner = "liberal";
    else if (game.fascistPolicies >= 6) game.winner = "fascist";
    else nextPresident(game);
    if (game.winner) game.stage = "finished";
  } else nextPresident(game);
}

export function legalActions(game) {
  if (game.stage === "finished") return [];
  if (game.stage === "nomination") return eligibleChancellors(game).map((chancellor) => ({ type: "nominate", chancellor }));
  if (game.stage === "vote") return [{ type: "vote", vote: "yes" }, { type: "vote", vote: "no" }];
  if (game.stage === "president-discard") return game.pendingCards.map((_, index) => ({ type: "discard", index }));
  if (game.stage === "chancellor-policy") {
    const actions = game.pendingCards.map((_, index) => ({ type: "enact", index }));
    if (game.fascistPolicies >= 5 && !game.vetoDenied) actions.push({ type: "veto" });
    return actions;
  }
  if (game.stage === "veto-decision") return [true, false].map((approved) => ({ type: "veto-decision", approved }));
  if (game.stage === "power") return livingSeats(game).filter((seat) => seat !== game.president).map((target) => ({ type: "power", target }));
  return [];
}

export function terminalUtility(game, seat) {
  if (game.stage !== "finished") throw new Error("Utility is defined only for terminal states.");
  const isFascist = game.roles[seat - 1] !== LIBERAL;
  return (game.winner === "fascist") === isFascist ? 1 : -1;
}

export function applyAction(source, action, { random = Math.random } = {}) {
  const game = structuredClone(source);
  if (game.stage === "finished") throw new Error("Game is finished.");
  if (game.stage === "nomination") {
    if (action.type !== "nominate" || !eligibleChancellors(game).includes(action.chancellor)) throw new Error("Illegal nomination.");
    game.chancellor = action.chancellor;
    game.votingOrder = livingSeats(game);
    game.votingIndex = 0;
    game.pendingVotes = {};
    game.stage = "vote";
  } else if (game.stage === "vote") {
    const votingSeat = currentPlayer(game);
    if (action.type !== "vote" || !["yes", "no"].includes(action.vote) || !votingSeat) throw new Error("Illegal vote.");
    game.pendingVotes[votingSeat] = action.vote;
    game.votingIndex += 1;
    if (game.votingIndex < game.votingOrder.length) return game;
    const votes = { ...game.pendingVotes };
    const passed = Object.values(votes).filter((vote) => vote === "yes").length > game.votingOrder.length / 2;
    game.history.push({ type: "vote", votes, passed, president: game.president, chancellor: game.chancellor });
    game.pendingVotes = {};
    game.votingOrder = [];
    game.votingIndex = 0;
    if (!passed) resolveFailedElection(game, random);
    else if (game.roles[game.chancellor - 1] === "hitler" && game.fascistPolicies >= 3) {
      game.winner = "fascist";
      game.stage = "finished";
    } else {
      game.electionTracker = 0;
      game.lastPresident = game.president;
      game.lastChancellor = game.chancellor;
      reshuffleDiscard(game, random);
      game.pendingCards = game.drawPile.splice(0, 3);
      game.stage = "president-discard";
    }
  } else if (game.stage === "president-discard") {
    if (action.type !== "discard" || !Number.isInteger(action.index) || action.index < 0 || action.index > 2) throw new Error("Choose one of the three policies to discard.");
    game.discardPile.push(game.pendingCards.splice(action.index, 1)[0]);
    game.stage = "chancellor-policy";
  } else if (game.stage === "chancellor-policy") {
    if (action.type === "veto") {
      if (game.fascistPolicies < 5 || game.vetoDenied) throw new Error("Veto is unavailable.");
      game.stage = "veto-decision";
    } else if (action.type === "enact" && Number.isInteger(action.index) && action.index >= 0 && action.index < game.pendingCards.length) {
      enact(game, action.index, random);
    } else throw new Error("Choose a pending policy or request a legal veto.");
  } else if (game.stage === "veto-decision") {
    if (action.type !== "veto-decision" || typeof action.approved !== "boolean") throw new Error("Record the president's veto decision.");
    if (action.approved) resolveFailedElection(game, random);
    else {
      game.vetoDenied = true;
      game.stage = "chancellor-policy";
    }
  } else if (game.stage === "power") {
    if (!Number.isInteger(action.target) || action.target === game.president || game.eliminated.includes(action.target)) throw new Error("Invalid power target.");
    if (game.pendingPower === "investigate") {
      const party = game.roles[action.target - 1] === LIBERAL ? LIBERAL : FASCIST;
      game.privateObservations[game.president] ??= [];
      game.privateObservations[game.president].push({ type: "investigation", target: action.target, party });
      game.history.push({ type: "investigation", president: game.president, target: action.target });
    }
    if (game.pendingPower === "execute") {
      game.eliminated.push(action.target);
      game.history.push({ type: "execution", president: game.president, target: action.target });
      if (game.roles[action.target - 1] === "hitler") {
        game.winner = "liberal";
        game.stage = "finished";
      }
    }
    if (game.stage === "finished") return game;
    if (game.pendingPower === "special") {
      game.specialReturn = game.president;
      game.president = action.target;
      game.chancellor = 0;
      game.pendingPower = "";
      game.stage = "nomination";
    } else nextPresident(game);
  } else throw new Error(`Unknown stage: ${game.stage}`);
  return game;
}

function enact(game, index, random) {
  const policy = game.pendingCards.splice(index, 1)[0];
  game.discardPile.push(...game.pendingCards);
  game.pendingCards = [];
  if (policy === LIBERAL) game.liberalPolicies += 1;
  else game.fascistPolicies += 1;
  game.history.push({ type: "policy", policy, president: game.president, chancellor: game.chancellor });
  if (game.liberalPolicies >= 5) game.winner = "liberal";
  else if (game.fascistPolicies >= 6) game.winner = "fascist";
  if (game.winner) {
    game.stage = "finished";
    return;
  }
  const count = game.fascistPolicies;
  const players = game.players;
  game.pendingPower = ((players >= 9 && count <= 2) || (players >= 7 && players <= 8 && count === 2))
    ? "investigate"
    : count === 3 ? "special" : count === 4 || count === 5 ? "execute" : "";
  if (game.pendingPower) game.stage = "power";
  else nextPresident(game);
}
