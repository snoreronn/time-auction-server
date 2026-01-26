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
  phase: "lobby", // lobby | countdown | auction | roundEnd
  round: 0,
  totalRounds: 19,
  players: {}, // id -> player object
  roundData: null
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
    const p = Object.values(game.players).find(p=>p.socketId===socket.id);
    if(!p || p.tappedIn) return;
    p.tappedIn = true;
    p.holding = true;

    io.emit("state", publicState());

    // If all players tapped in, start countdown
    const allTapped = Object.values(game.players).length > 0 &&
                       Object.values(game.players).every(p=>p.tappedIn);
    if(allTapped && game.phase==="lobby"){
      startCountdown();
    }
  });

  socket.on("hold_start", () => {
    const p = Object.values(game.players).find(p=>p.socketId===socket.id);
    if(!p || !p.tappedIn) return;
    p.holding = true;
    io.emit("state", publicState());
  });

  socket.on("hold_end", () => {
    const p = Object.values(game.players).find(p=>p.socketId===socket.id);
    if(!p || !p.holding) return;
    p.holding = false;
    io.emit("state", publicState());
    checkAuctionEnd();
  });

  socket.on("disconnect", () => {
    const p = Object.values(game.players).find(p=>p.socketId===socket.id);
    if(p) p.socketId = null; // temporary disconnect
  });
});

// ------------------ Game Flow ------------------
function startCountdown(){
  game.phase = "countdown";
  const endsAt = Date.now() + COUNTDOWN_MS;
  io.emit("countdown_start", { endsAt });

  setTimeout(()=>{
    startAuction();
  }, COUNTDOWN_MS);
}

function startAuction(){
  game.phase = "auction";
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
    .filter(p=>p.tappedIn)
    .map(p=>({id:p.id,bid:p.bidMs||0}));

  let winner = null;
  let tie = false;

  if(bids.length>0){
    bids.sort((a,b)=>b.bid-a.bid);
    if(bids.length>1 && bids[0].bid === bids[1].bid) tie = true;
    else winner = bids[0].id;
    if(winner) game.players[winner].tokens += 1;
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
