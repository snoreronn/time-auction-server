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
  players: {}, // socketId -> player
  roundData: null
};

function restartGame() {
  // Reset all game state
  game.phase = "lobby";
  game.round = 0;
  game.roundData = null;
  
  // Reset all players
  Object.values(game.players).forEach(p => {
    p.remainingMs = GAME_DURATION_MS;
    p.tokens = 0;
    p.holding = false;
    p.holdStart = null;
    p.bidMs = null;
    p.tappedIn = false;
  });
  
  // Broadcast the reset state to all clients
  io.emit("game_restart");
  io.emit("state", gamePublicState());
}

function createPlayer(id, name) {
  return {
    id,
    name,
    remainingMs: GAME_DURATION_MS,
    tokens: 0,
    holding: false,
    holdStart: null,
    bidMs: null,
    tappedIn: false
  };
}

// ---- Socket Logic ----
io.on("connection", socket => {
  socket.on("join", name => {
    game.players[socket.id] = createPlayer(socket.id, name);
    io.emit("state", gamePublicState());
  });

  const p = game.players[socket.id];

  // Listen for host starting the round
  socket.on("host_start_round", () => {
    // Only allow start if there is at least one player
    const numPlayers = Object.keys(game.players).length;
    if (numPlayers === 0) return;

    // Only allow if phase is lobby or roundEnd
    if (game.phase === "lobby" || game.phase === "roundEnd") {
      startRound();
    }
  });

  // Player join
  socket.on("join", name => {
    game.players[socket.id] = createPlayer(socket.id, name);
    io.emit("state", gamePublicState());
  });


  socket.on("tap_in", () => {
    if (game.players[socket.id]) {
      game.players[socket.id].tappedIn = true;
      io.emit("state", gamePublicState());
    }
  });

  socket.on("hold_start", () => {
    const p = game.players[socket.id];
    if (!p || game.phase !== "auction") return;
    if (p.remainingMs <= 0) return;
    p.holding = true;
    p.holdStart = Date.now();
  });

  socket.on("hold_end", () => {
    const p = game.players[socket.id];
    if (!p || !p.holding) return;
    const now = Date.now();
    let used = now - p.holdStart;
    if (used > p.remainingMs) used = p.remainingMs;
    p.remainingMs -= used;
    p.bidMs = used;
    p.holding = false;
    p.holdStart = null;

    checkAuctionEnd();
  });

  socket.on("disconnect", () => {
    delete game.players[socket.id];
    io.emit("state", gamePublicState());
  });
});

// ---- Auction Flow ----
function startRound() {
  game.round += 1;
  game.phase = "countdown";
  game.roundData = { bids: {} };

  Object.values(game.players).forEach(p => {
    p.tappedIn = false;
    p.bidMs = null;
  });

  io.emit("countdown_start", COUNTDOWN_MS);

  setTimeout(() => {
    game.phase = "auction";
    io.emit("auction_start");
  }, COUNTDOWN_MS);
}

function checkAuctionEnd() {
  const active = Object.values(game.players).filter(p => p.holding);
  if (active.length === 0) endAuction();
}

function endAuction() {
  game.phase = "roundEnd";

  const bids = Object.values(game.players)
    .filter(p => p.bidMs !== null)
    .map(p => ({ id: p.id, bid: Math.round(p.bidMs / 100) * 100 }));

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

function gamePublicState(showTimes = false) {
  return {
    phase: game.phase,
    round: game.round,
    players: Object.values(game.players).map(p => ({
      name: p.name,
      tokens: p.tokens,
      remainingMs: showTimes ? p.remainingMs : null,
      tappedIn: p.tappedIn
    }))
  };
}

// ---- Host Controls (temporary REST) ----
app.get("/start", (_, res) => {
  if (game.phase === "lobby" || game.phase === "roundEnd") {
    startRound();
    res.send("Round started");
  } else res.send("Cannot start now");
});

app.get("/restart", (_, res) => {
  restartGame();
  res.send("Game restarted");
});

server.listen(3000, () => console.log("Time Auction server running on :3000"));
