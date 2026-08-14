const { Room } = require('./game');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion

function randomCode(len = 4) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // code -> Room
  }

  createRoom() {
    let code;
    do {
      code = randomCode();
    } while (this.rooms.has(code));
    const room = new Room(code, this.io);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  // The most recently created lobby that's still accepting players - used to
  // auto-suggest a room code on the join screen so guests don't have to ask for it.
  findOpenLobby() {
    let best = null;
    for (const room of this.rooms.values()) {
      if (room.phase === 'lobby' && (!best || room.createdAt > best.createdAt)) {
        best = room;
      }
    }
    return best;
  }

  reap() {
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      const allDisconnected = room.order.every((id) => !room.players.get(id)?.connected);
      const stale = now - room.createdAt > 1000 * 60 * 60 * 6; // 6 hours
      if ((allDisconnected && room.order.length > 0) || stale) {
        this.rooms.delete(code);
      }
    }
  }

  // Aggregate, non-identifying counts only -- no room codes, names, or game
  // state -- safe to expose publicly for a "people playing right now" badge.
  getStatus() {
    this.reap();
    let activeRooms = 0;
    let activePlayers = 0;
    for (const room of this.rooms.values()) {
      const connected = room.order.filter((id) => room.players.get(id)?.connected).length;
      if (connected > 0) {
        activeRooms++;
        activePlayers += connected;
      }
    }
    return { activeRooms, activePlayers };
  }
}

module.exports = { RoomManager };
