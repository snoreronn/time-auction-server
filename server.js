// Time Auction MVP Server
// Node.js + Express + Socket.IO

// Time Auction Server – Multiplayer Persistent Holding
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const GAME_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const COUNTDOWN_MS = 5000;

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
  totalRounds: 19,
  players: {}, // id -> player object
  roundData: {}
};

// ------------------ Player Factory ------------------
function createPlayer(id, name, socketId){
  return {
    id,
    name,
    socketId,
    remainingMs: GAME_DURATION_MS,
    tokens: 0,
    tappedIn: false,
    holding: false,
    bidMs: null
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

  // Host indicates all players are ready for the round
  // Resets player states for the new round
  socket.on("host_reset_for_round", () => {
    if(game.phase !== "startGame" && game.phase !== "roundEnd") return;
    game.phase = "startGame";
    io.emit("state", publicState());
    io.emit("reset_for_round")
  });

  // Host starts the round → countdown begins
  // Requires all players to be tapped in
  socket.on("host_start_round", () => {
    if(game.phase !== "playersReady") return;
    game.round += 1;
    startCountdown();
  });

  // Player starts holding to bid time
  socket.on("hold_start", () => {
    const p = findPlayerBySocketId(socket.id);
    if(!p || !p.tappedIn) return;
    p.holding = true;
    io.emit("state", publicState());
  });

  // Player stops holding
  socket.on("hold_end", ( playerEndTime ) => {
    const p = findPlayerBySocketId(socket.id);
    if(!p || !p.holding) return;
    p.holding = false;
    p.bidMs = playerEndTime - (game.roundData ? game.roundData.auctionStartsAt : 0);
    io.emit("state", publicState());
    checkAuctionEnd();
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
function startAuction(){
  game.phase = "auction";
  io.emit("state", publicState());
  io.emit("auction_start");
}

function checkAuctionEnd(){
  if(game.phase!=="auction") return;
  const active = Object.values(game.players).filter(p=>p.holding);
  if(active.length===0) endAuction();
}

function endAuction(){
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
  io.emit("state", publicState(true));

  // reset for next round
  Object.values(game.players).forEach(p=>{
    p.tappedIn = false;
    p.holding = false;
    p.bidMs = null;
  });

  // Ready for the next round
  game.phase = "startGame";
}

// ------------------ Public State ------------------
function publicState(showTimes=false){
  return {
    phase: game.phase,
    round: game.round,
    players: Object.values(game.players).map(p=>({
      name: p.name,
      tokens: p.tokens,
      tappedIn: p.tappedIn,
      holding: p.holding,
      remainingMs: showTimes ? p.remainingMs : null
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
