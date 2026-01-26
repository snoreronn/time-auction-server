// Time Auction MVP Server
// Node.js + Express + Socket.IO

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const GAME_DURATION_MS = 10 * 60 * 1000;
const COUNTDOWN_MS = 5000;

let game = {
  phase: "lobby", // lobby | countdown | auction | roundEnd
  round: 0,
  totalRounds: 19,
  players: {},
  auctionStartAt: null
};

function now() {
  return Date.now();
}

function createPlayer(id, name) {
  return {
    id,
    name,
    socketId: null,
    remainingMs: GAME_DURATION_MS,
    tokens: 0,
    tappedIn: false,
    holding: false,
    holdStartedAt: null,
    bidMs: null
  };
}

function findPlayerBySocket(socketId) {
  return Object.values(game.players).find(p => p.socketId === socketId);
}

// ---- SOCKETS ----
io.on("connection", socket => {
  socket.on("join", ({ id, name }) => {
    if (!game.players[id]) {
      game.players[id] = createPlayer(id, name);
    }

    game.players[id].socketId = socket.id;
    io.emit("state", gamePublicState());
  });

  socket.on("host_start_round", () => {
    if (game.phase !== "lobby" && game.phase !== "roundEnd") return;
    if (Object.keys(game.players).length === 0) return;
    startRound();
  });

  socket.on("tap_in", () => {
    const player = findPlayerBySocket(socket.id);
    if (!player || player.tappedIn) return;

    player.tappedIn = true;
    io.emit("state", gamePublicState());

    // Check if ALL players tapped in
    const allTapped = Object.values(game.players).every(p => p.tappedIn);
    if (allTapped && game.phase === "countdown") {
      // Start 5-second countdown
      const COUNTDOWN_MS = 5000;
      const endsAt = Date.now() + COUNTDOWN_MS;
      game.phase = "countdownActive"; // temp phase

      io.emit("countdown_start", { endsAt });

      // After countdown, start auction
      setTimeout(() => {
        game.phase = "auction";
        // reset hold info
        Object.values(game.players).forEach(p => { p.holding = false; p.bidMs = null; });
        io.emit("auction_start");
        io.emit("state", gamePublicState());
      }, COUNTDOWN_MS);
    }
  });

  socket.on("hold_start", () => {
    const p = findPlayerBySocket(socket.id);
    if (!p || game.phase !== "auction" || !p.tappedIn) return;
    if (p.holding) return;

    p.holding = true;
    p.holdStartedAt = now();
  });

  socket.on("hold_end", () => {
    const p = findPlayerBySocket(socket.id);
    if (!p || !p.holding) return;

    const elapsed = now() - p.holdStartedAt;
    p.remainingMs = Math.max(0, p.remainingMs - elapsed);
    p.bidMs = elapsed;

    p.holding = false;
    p.holdStartedAt = null;

    checkAuctionEnd();
  });

  socket.on("disconnect", () => {
    const p = findPlayerBySocket(socket.id);
    if (p) p.socketId = null;
  });
});

// ---- GAME FLOW ----
function startRound() {
  game.round++;
  game.phase = "countdown";

  Object.values(game.players).forEach(p => {
    p.tappedIn = false;
    p.holding = false;
    p.bidMs = null;
  });

  const countdownEndsAt = now() + COUNTDOWN_MS;
  io.emit("countdown_start", { endsAt: countdownEndsAt });
  io.emit("state", gamePublicState());

  setTimeout(() => {
    const players = Object.values(game.players);
    if (!players.every(p => p.tappedIn)) {
      game.phase = "lobby";
      io.emit("round_aborted", { reason: "not_all_tapped_in" });
      io.emit("state", gamePublicState());
      return;
    }

    game.phase = "auction";
    game.auctionStartAt = now();
    io.emit("auction_start");
    io.emit("state", gamePublicState());
  }, COUNTDOWN_MS);
}

function checkAuctionEnd() {
  const active = Object.values(game.players).some(p => p.holding);
  if (!active) endAuction();
}

function endAuction() {
  game.phase = "roundEnd";

  const bids = Object.values(game.players)
    .filter(p => p.bidMs !== null)
    .map(p => ({
      id: p.id,
      bid: Math.round(p.bidMs / 100) * 100
    }))
    .sort((a, b) => b.bid - a.bid);

  let winner = null;
  let tie = false;

  if (bids.length > 0) {
    if (bids.length > 1 && bids[0].bid === bids[1].bid) {
      tie = true;
    } else {
      winner = bids[0].id;
      game.players[winner].tokens++;
    }
  }

  io.emit("round_result", {
    winner: winner ? game.players[winner].name : null,
    tie
  });

  io.emit("state", gamePublicState(true));
}

function gamePublicState(showTimes = false) {
  return {
    phase: game.phase,
    round: game.round,
    players: Object.values(game.players).map(p => ({
      name: p.name,
      tokens: p.tokens,
      remainingMs: showTimes ? p.remainingMs : null,
      tappedIn: p.tappedIn,
      holding: p.holding
    }))
  };
}

server.listen(3000, () =>
  console.log("Time Auction server running on :3000")
);
