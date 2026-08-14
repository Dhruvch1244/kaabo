const os = require('os');
const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');
const { MIN_PLAYERS, MAX_PLAYERS, AVATARS } = require('./game');

const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  // Local network only - keep payloads small and pings frequent so a phone
  // that walks out of WiFi range is detected quickly.
  pingInterval: 4000,
  pingTimeout: 8000,
});

const rooms = new RoomManager(io);

app.use(express.static(path.join(__dirname, '..', 'public')));

function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

app.get('/api/host-info', (req, res) => {
  rooms.reap();
  const open = rooms.findOpenLobby();
  res.json({
    addresses: lanAddresses(),
    port: PORT,
    openRoomCode: open ? open.code : null,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    avatars: AVATARS,
  });
});

// Public, cross-origin, read-only: lets the portfolio site show a
// "X people playing right now" badge without exposing anything about
// individual rooms.
app.get('/api/status', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json(rooms.getStatus());
});

function safeHandle(socket, fn) {
  return (payload, ack) => {
    try {
      const result = fn(payload) || {};
      if (typeof ack === 'function') ack({ ok: true, ...result });
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
      else socket.emit('action-error', { message: err.message });
    }
  };
}

function getRoom(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) throw new Error('Room no longer exists.');
  return room;
}

io.on('connection', (socket) => {
  socket.on(
    'create-room',
    safeHandle(socket, ({ playerId, name, avatar } = {}) => {
      if (!playerId || !name) throw new Error('Missing player info.');
      const room = rooms.createRoom();
      room.addPlayer(playerId, name, socket.id, avatar);
      socket.data.roomCode = room.code;
      socket.data.playerId = playerId;
      socket.join(room.code);
      room.broadcast();
      return { code: room.code, playerId };
    })
  );

  socket.on(
    'join-room',
    safeHandle(socket, ({ roomCode, playerId, name, avatar } = {}) => {
      if (!roomCode || !playerId || !name) throw new Error('Missing player info.');
      const room = rooms.get(roomCode);
      if (!room) throw new Error('Room not found. Check the code.');
      room.addPlayer(playerId, name, socket.id, avatar);
      socket.data.roomCode = room.code;
      socket.data.playerId = playerId;
      socket.join(room.code);
      room.broadcast();
      return { code: room.code, playerId };
    })
  );

  socket.on(
    'rejoin-room',
    safeHandle(socket, ({ roomCode, playerId } = {}) => {
      const room = rooms.get(roomCode);
      if (!room) throw new Error('Room no longer exists.');
      if (!room.players.has(playerId)) throw new Error('You are not part of that room.');
      room.addPlayer(playerId, room.players.get(playerId).name, socket.id);
      socket.data.roomCode = room.code;
      socket.data.playerId = playerId;
      socket.join(room.code);
      room.broadcast();
      return { code: room.code, playerId };
    })
  );

  const withRoom = (fn) =>
    safeHandle(socket, (payload) => {
      const room = getRoom(socket);
      const playerId = socket.data.playerId;
      fn(room, playerId, payload || {});
    });

  socket.on('update-settings', withRoom((room, playerId, p) => room.updateSettings(playerId, p)));
  socket.on('kick-player', withRoom((room, playerId, p) => room.kickPlayer(playerId, p.targetId)));
  socket.on('start-game', withRoom((room, playerId) => room.startGame(playerId)));
  socket.on('ready', withRoom((room, playerId) => room.readyForRound(playerId)));
  socket.on('draw-pile', withRoom((room, playerId) => room.drawFromPile(playerId)));
  socket.on('draw-discard', withRoom((room, playerId) => room.drawFromDiscard(playerId)));
  socket.on('swap-drawn', withRoom((room, playerId, p) => room.swapDrawn(playerId, p.slot)));
  socket.on('discard-drawn', withRoom((room, playerId) => room.discardDrawn(playerId)));
  socket.on('skip-power', withRoom((room, playerId) => room.skipPower(playerId)));
  socket.on('power-peek-self', withRoom((room, playerId, p) => room.usePowerPeekSelf(playerId, p.slot)));
  socket.on('power-peek-opponent', withRoom((room, playerId, p) => room.usePowerPeekOpponent(playerId, p.targetId, p.slot)));
  socket.on('power-blind-swap', withRoom((room, playerId, p) => room.usePowerBlindSwap(playerId, p.a, p.b)));
  socket.on('power-look-swap-select', withRoom((room, playerId, p) => room.usePowerLookSwapSelect(playerId, p.a, p.b)));
  socket.on('power-look-swap-decide', withRoom((room, playerId, p) => room.usePowerLookSwapDecide(playerId, !!p.swap)));
  socket.on('slap', withRoom((room, playerId, p) => room.slapDiscard(playerId, p.slot)));
  socket.on('call-cabo', withRoom((room, playerId) => room.callCabo(playerId)));
  socket.on('next-round', withRoom((room, playerId) => room.startNextRound(playerId)));
  socket.on('restart-game', withRoom((room, playerId) => room.restartGame(playerId)));

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (room) {
      room.disconnectSocket(socket.id);
      room.broadcast();
    }
  });
});

setInterval(() => rooms.reap(), 1000 * 60 * 10);

httpServer.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  console.log('');
  console.log('  Kaabo is running!');
  console.log(`  On this device:  http://localhost:${PORT}`);
  if (addrs.length) {
    console.log('  On the same WiFi/hotspot, others should open:');
    addrs.forEach((a) => console.log(`    http://${a}:${PORT}`));
  } else {
    console.log('  Could not detect a LAN address - make sure this device is on the hotspot/WiFi.');
  }
  console.log('');
});
