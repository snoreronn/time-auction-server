// Time Auction MVP Server
// Node.js + Express + Socket.IO

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// ---- Game State ----
const GAME_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const COUNTDOWN_MS = 5000;

let game = {
  phase: "lobby", // lobby | countdown | auction | roundEnd
  round: 0,
  totalRounds: 19,
  players: {}, // id -> player
  roundData: null
};

function restartGame() {
  game.phase = "lobby";
  game.round = 0;
  game.roundData = null;

  Object.values(game.players).forEach(p => {
    p.remainingMs = GAME_DURATION_MS;
    p.tokens = 0;
    p.holding = false;
    p.holdStartAt = null;
    p.bidMs = null;
    p.tappedIn = false;
  });

  io.emit("game_restart");
  io.emit("state", gamePublicState());
}

function createPlayer(id, name) {
  return {
    id,
    name,
    socketId: null,
    remainingMs: GAME_DURATION_MS,
    tokens: 0,
    holding: false,
    holdStartAt: null,
    bidMs: null,
    tappedIn: false
  };
}

// ---- Socket Logic ----
io.on("connection", socket => {
  socket.on("join", ({ id, name }) => {
    if (!game.players[id]) {
      game.players[id] = createPlayer(id, name);
    }

    game.players[id].socketId = socket.id;
    game.players[id].name = name;

    io.emit("state", gamePublicState());
  });

  socket.on("host_start_round", () => {
    if (
      Object.keys(game.players).length > 0 &&
      (game.phase === "lobby" || game.phase === "roundEnd")
    ) {
      startRound();
    }
  });

  socket.on("tap_in", () => {
    const p = findPlayerBySocket(socket.id);
    if (!p || game.phase !== "countdown") return;

    p.tappedIn = true;
    io.emit("state", gamePublicState());
  });

  socket.on("hold_start", ({ at }) => {
    const p = findPlayerBySocket(socket.id);
    if (!p || game.phase !== "auction" || !p.tappedIn) return;

    if (!p.holding) {
      p.holding = true;
      p.holdStartAt = at;
    }
  });

  socket.on("hold_end", ({ at }) => {
    const p = findPlayerBySocket(socket.id);
    if (!p || !p.holding) return;

    p.holding = false;
    p.bidMs = at - p.holdStartAt;
    p.holdStartAt = null;

    checkAuctionEnd();
  });

  socket.on("disconnect", () => {
    const p = findPlayerBySocket(socket.id);
    if (!p) return;

    // Treat disconnect as letting go
    if (p.holding && p.holdStartAt) {
      p.bidMs = Date.now() - p.holdStartAt;
      p.holding = false;
      p.holdStartAt = null;
      checkAuctionEnd();
    }

    p.socketId = null;
  });
});

// ---- Auction Flow ----
function startRound() {
  game.round += 1;
  game.phase = "countdown";
  game.roundData = { bids: {} };

  Object.values(game.players).forEach(p => {
    p.tappedIn = false;
    p.holding = false;
    p.holdStartAt = null;
    p.bidMs = null;
  });

  const endsAt = Date.now() + COUNTDOWN_MS;
  io.emit("countdown_start", { endsAt });

  setTimeout(() => {
    game.phase = "auction";
    io.emit("auction_start");
  }, COUNTDOWN_MS);
}

function checkAuctionEnd() {
  const stillHolding = Object.values(game.players).some(p => p.holding);
  if (!stillHolding) endAuction();
}

function endAuction() {
  game.phase = "roundEnd";

  const bids = Object.values(game.players)
    .filter(p => p.bidMs !== null)
    .map(p => ({
      id: p.id,
      bid: Math.round(p.bidMs / 100) * 100
    }));

  let winner = null;
  let tie = false;

  if (bids.length > 0) {
    bids.sort((a, b) => b.bid - a.bid);

    if (bids.length > 1 && bids[0].bid === bids[1].bid) {
      tie = true;
    } else {
      winner = bids[0].id;
      game.players[winner].tokens += 1;
    }
  }

  io.emit("round_result", {
    winner: winner ? game.players[winner].name : null,
    tie
  });

  io.emit("state", gamePublicState(true));
}

function findPlayerBySocket(socketId) {
  return Object.values(game.players).find(p => p.socketId === socketId);
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

// ---- Host Controls ----
app.get("/start", (_, res) => {
  if (game.phase === "lobby" || game.phase === "roundEnd") {
    startRound();
    res.send("Round started");
  } else {
    res.send("Cannot start now");
  }
});

app.get("/restart", (_, res) => {
  restartGame();
  res.send("Game restarted");
});

server.listen(3000, () =>
  console.log("Time Auction server running on :3000")
);
