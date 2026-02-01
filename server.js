// Time Auction MVP Server
// Node.js + Express + Socket.IO

// Time Auction Server – Multiplayer Persistent Holding
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Configuration from environment variables
const GAME_DURATION_MINUTES = parseFloat(process.env.GAME_DURATION_MINUTES || "10"); // 10 minutes default
// const GAME_DURATION_MS = Math.round(GAME_DURATION_MINUTES * 60 * 1000);
const COUNTDOWN_MS = parseInt(process.env.COUNTDOWN_MS || "5000"); // 5 seconds default
const TOTAL_ROUNDS = parseInt(process.env.TOTAL_ROUNDS || "19"); // 19 rounds default

let game = {
  // Definition of game phases
  //  lobby: waiting for players to join
  //  startGame: host has started the game, players can no longer join [Requires Host Button]
  //  playersReady: all players tapped in, waiting for host to start round [Players all Tap In]
  //  countdown: countdown before auction starts [Requires Host to Start Round]
  //  auction: players can hold to bid 
  //  roundEnd: auction ended, showing results [Triggered by last player releasing hold]
  phase: "lobby",
  round: 0,
  totalRounds: TOTAL_ROUNDS,
  settings: {
    totalRounds: TOTAL_ROUNDS,
    gameDurationMinutes: GAME_DURATION_MINUTES
  },
  players: {}, // id -> player object
  roundData: {}
};

function resolveDurationMs() {
  const minutes = parseFloat(game.settings?.gameDurationMinutes || GAME_DURATION_MINUTES);
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : GAME_DURATION_MINUTES;
  return Math.round(safeMinutes * 60 * 1000);
}

// ------------------ Player Factory ------------------
function createPlayer(id, name, socketId){
  return {
    id,
    name,
    socketId,
    remainingMs: resolveDurationMs(),
    tokens: 0,
    tappedIn: false,
    holding: false,
    bidMs: null,
    holdingAtAuctionStart: false // Used to prevent players from joining when the auction has started
  };
}

// ------------------ Find Player by SocketId ------------------
function findPlayerBySocketId(socketId){
  return Object.values(game.players).find(p=>p.socketId===socketId);
}

// ------------------ Determine if all Players are Ready ------------------
function allTapped() {
  return Object.values(game.players).length > 0 &&
          Object.values(game.players).every(p=>p.tappedIn);
}

// ------------------ Socket Logic ------------------
io.on("connection", socket => {

  socket.on("join", ({id, name}) => {
    const isNewPlayer = !game.players[id];
    
    // Only allow new players to join during lobby phase
    if (isNewPlayer && game.phase !== "lobby") return;

    if(game.players[id]){
      game.players[id].socketId = socket.id;
      game.players[id].name = name;
    } else {
      game.players[id] = createPlayer(id,name,socket.id);
    }
    io.emit("state", publicState());
  });

  // Player taps in → start holding automatically
  socket.on("tap_in", () => {
    const p = findPlayerBySocketId(socket.id);
    if(!p || p.tappedIn) return;

    // 🚫 Cannot tap in once countdown has completed
    if (game.phase === "auction") return;

    p.tappedIn = true;
    p.holding = true;

    io.emit("state", publicState());

    // If all players tapped in, start countdown
    if(allTapped() && game.phase==="startGame"){
      game.phase = "playersReady";
      io.emit("state", publicState());
      // startCountdown();
    }
  });

  // Player taps out → untap and stop holding
  socket.on("tap_out", () => {
    const p = findPlayerBySocketId(socket.id);
    if(!p) return;
    p.tappedIn = false;
    p.holding = false;
    io.emit("state", publicState());
  });

  // Host starts the game → no more players can join
  socket.on("host_start_game", () => {
    if(game.phase !== "lobby") return;
    game.phase = "startGame";
    io.emit("state", publicState());
  });

  // Host updates game settings (rounds + minutes)
  socket.on("host_update_settings", ({ totalRounds, gameDurationMinutes }) => {
    if (game.phase !== "lobby") return;

    const parsedRounds = parseInt(totalRounds, 10);
    const parsedMinutes = parseFloat(gameDurationMinutes);

    const safeRounds = Number.isFinite(parsedRounds) && parsedRounds > 0 ? parsedRounds : TOTAL_ROUNDS;
    const safeMinutes = Number.isFinite(parsedMinutes) && parsedMinutes > 0 ? parsedMinutes : GAME_DURATION_MINUTES;

    game.settings.totalRounds = safeRounds;
    game.settings.gameDurationMinutes = safeMinutes;
    game.totalRounds = safeRounds;

    // Apply new duration to all players if the game hasn't started a round yet
    if (game.round === 0) {
      const newDurationMs = resolveDurationMs();
      Object.values(game.players).forEach(p => {
        p.remainingMs = newDurationMs;
      });
    }

    io.emit("state", publicState());
  });

  // Host indicates all players are ready for the round
  // Resets player states for the new round
  socket.on("host_reset_for_round", () => {
    if(game.phase !== "startGame" && game.phase !== "roundEnd") return;
    if (game.round >= game.totalRounds) return;
    game.phase = "startGame";
    game.roundData = {};
    Object.values(game.players).forEach(p=>{
      p.tappedIn = false;
      p.holding = false;
      p.bidMs = null;
      p.holdingAtAuctionStart = false;
    })
    io.emit("state", publicState());
    io.emit("reset_for_round")
  });

  // Host starts the round → countdown begins
  // Requires all players to be tapped in
  socket.on("host_start_round", () => {
    if(game.phase !== "playersReady") return;
    if (game.round >= game.totalRounds) return;
    game.round += 1;
    startCountdown();
  });

  // Player starts holding to bid time
  socket.on("hold_start", () => {
    const p = findPlayerBySocketId(socket.id);
    if(!p || !p.tappedIn) return;

    // 🚫 Cannot join after auction start
    // ❌ Countdown finished — cannot newly start holding
    if ( game.phase === "auction" && !p.holdingAtAuctionStart ) {

          io.to(socket.id).emit("locked_out");
          return;
    }

    p.holding = true;
    io.emit("state", publicState());
  });

  // Player stops holding
  socket.on("hold_end", ( playerEndTime ) => {
    const p = findPlayerBySocketId(socket.id);
    if(!p || !p.holding) return;
    p.holding = false;
    
    // Only count bid time if during auction phase
    if (game.phase === "auction" && game.roundData && game.roundData.auctionStartsAt) {
      p.bidMs = playerEndTime - game.roundData.auctionStartsAt;
    } else {
      p.bidMs = 0;
    }
    
    // Subtract the bid time from remaining time pool
    p.remainingMs = Math.max(0, p.remainingMs - p.bidMs);
    
    // Check if player hit 0 remaining time
    if (p.remainingMs <= 0) {
      io.to(socket.id).emit("time_expired");
    }
    
    io.emit("state", publicState());
    checkAuctionEnd();
  });

  socket.on("player_leave", () => {
    // Only allow leaving during lobby phase
    if (game.phase !== "lobby") return;

    const p = findPlayerBySocketId(socket.id);
    if(p) {
      delete game.players[p.id];
      // Broadcast updated state to all clients immediately
      io.emit("state", publicState());
    }
  });

  socket.on("disconnect", () => {
    const p = findPlayerBySocketId(socket.id);
    if(p) p.socketId = null; // temporary disconnect
  });
});

// ------------------ Game Flow ------------------
// Countdown is triggered by Host "Start Round" button
function startCountdown(){
  game.phase = "countdown";
  auctionStartsAt = Date.now() + COUNTDOWN_MS;
  io.emit("state", publicState());
  io.emit("countdown_start", { auctionStartsAt });

  setTimeout(()=>{
    startAuction();
  }, COUNTDOWN_MS);

  game.roundData.auctionStartsAt = auctionStartsAt;
}

// Auction phase starts automatically after the countdown ends
let timeCheckInterval = null;

function startAuction(){
  game.phase = "auction";

  const auctionStart = game.roundData.auctionStartsAt;

  let activeAtStart = 0;

  // 🔒 Lock players who were NOT holding at auction start
  Object.values(game.players).forEach(p => {
    // Snapshot holding state
    p.holdingAtAuctionStart = p.holding;

    if (p.holdingAtAuctionStart) {
      activeAtStart += 1;
    } else {
      p.holding = false;
      p.bidMs = 0; // locked using auction start time

      if (p.socketId) {
        io.to(p.socketId).emit("locked_out");
      }
    }
  });

  io.emit("state", publicState());
  io.emit("auction_start", { auctionStartsAt: auctionStart });

  // If nobody is holding at the start of the auction, end immediately
  if (activeAtStart === 0)
  {
    endAuction();
    return;
  }

  // existing interval logic stays the same
  timeCheckInterval = setInterval(() => {
    if (game.phase !== "auction") {
      clearInterval(timeCheckInterval);
      return;
    }

    Object.values(game.players).forEach(p => {
      if (p.holding && p.remainingMs <= 0) {
        p.holding = false;
        p.bidMs = Math.max(0, Date.now() - auctionStart);
        p.remainingMs = 0;
        io.to(p.socketId).emit("time_expired");
        io.emit("state", publicState());
        checkAuctionEnd();
      }
    });
  }, 100);
}

function checkAuctionEnd(){
  if(game.phase!=="auction") return;
  const active = Object.values(game.players).filter(p=>p.holding);
  if(active.length===0) endAuction();
}

function endAuction(){
  game.phase = "roundEnd";
  
  // Clear the time check interval
  if (timeCheckInterval) {
    clearInterval(timeCheckInterval);
    timeCheckInterval = null;
  }

  const bids = Object.values(game.players)
    .filter(p => p.bidMs !== null)
    .map(p => ({ id: p.id, bid: Math.round(p.bidMs / 100) * 100 }));

  let winner = null;
  let tie = false;

  if (bids.length > 0) {
    bids.sort((a, b) => b.bid - a.bid);
    const topBid = bids[0].bid;
    const tied = bids.filter(b => b.bid === topBid);

    if (tied.length > 1) {
      tie = true;
      const splitToken = 1 / tied.length;
      tied.forEach(t => {
        if (game.players[t.id]) {
          game.players[t.id].tokens += splitToken;
        }
      });
    } else {
      winner = bids[0].id;
      game.players[winner].tokens += 1;
    }
  }

  // Emit updated state first (with tokens incremented)
  io.emit("state", publicState(true));
  
  io.emit("round_result", {
    winner: winner ? game.players[winner].name : null,
    tie
  });

  // reset for next round
  Object.values(game.players).forEach(p=>{
    p.tappedIn = false;
    p.holding = false;
    p.bidMs = null;
    p.holdingAtAuctionStart = false;
  });

  // Ready for the next round if any remain
  game.phase = game.round >= game.totalRounds ? "roundEnd" : "startGame";
}

// ------------------ Public State ------------------
function publicState(showTimes=false){
  return {
    phase: game.phase,
    round: game.round,
    totalRounds: game.totalRounds,
    settings: {
      totalRounds: game.settings.totalRounds,
      gameDurationMinutes: game.settings.gameDurationMinutes
    },
    players: Object.values(game.players).map(p=>({
      id: p.id,
      name: p.name,
      tokens: p.tokens,
      tappedIn: p.tappedIn,
      holding: p.holding,
      remainingMs: p.remainingMs
    }))
  };
}

// ------------------ REST for Host ------------------
app.get("/restart", (_,res)=>{
  game.players = {};
  game.phase="lobby";
  game.round=0;
  io.emit("state", publicState());
  res.send("Game reset");
});

server.listen(3000, ()=>console.log("Server running on :3000"));
