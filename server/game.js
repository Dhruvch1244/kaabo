const { buildDeck, shuffle } = require('./deck');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const CABO_PENALTY = 10;
const DEFAULT_TARGET_SCORE = 100;
const SLAP_WINDOW_MS = 3000;
const INITIAL_KNOWN_SLOTS = [2, 3]; // bottom row of the 2x2 deal

// Jewel tones instead of bright cartoon colors - each avatar reads like a
// gemstone on the felt rather than a kids'-app palette.
const PLAYER_COLORS = [
  '#9c3349', // ruby
  '#2f6690', // sapphire
  '#c9a44c', // topaz / gold
  '#6b4b8a', // amethyst
  '#2f7a5c', // emerald
  '#b0703f', // bronze
  '#2a8f8f', // teal
  '#a35a72', // rose-bronze
];

function publicCard(card) {
  if (!card) return null;
  return { rank: card.rank, suit: card.suit, value: card.value, power: card.power };
}

class Room {
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.hostId = null;
    this.players = new Map(); // id -> player
    this.order = []; // turn order, array of ids
    this.phase = 'lobby'; // lobby | peek | playing | reveal | gameover
    this.settings = { targetScore: DEFAULT_TARGET_SCORE };
    this.round = 0;
    this.drawPile = [];
    this.discardPile = [];
    this.currentTurn = 0;
    this.turnState = 'idle'; // idle | drawn | resolving-power
    this.drawnCard = null;
    this.drawnFrom = null;
    this.caboCallerId = null;
    this.turnsLeftAfterCabo = null;
    this.pendingPower = null;
    this.peekAcks = new Set();
    this.slapWindow = { active: false, timeout: null };
    this.log = [];
    this.createdAt = Date.now();
  }

  addLog(text) {
    this.log.push({ ts: Date.now(), text });
    if (this.log.length > 30) this.log.shift();
  }

  currentPlayerId() {
    return this.order[this.currentTurn];
  }

  requireTurn(playerId) {
    if (this.currentPlayerId() !== playerId) throw new Error("It's not your turn.");
  }

  // ---------- lobby ----------

  addPlayer(id, name, socketId) {
    if (this.players.has(id)) {
      const p = this.players.get(id);
      p.socketId = socketId;
      p.connected = true;
      this.addLog(`${p.name} reconnected.`);
      return p;
    }
    if (this.phase !== 'lobby') {
      throw new Error('This game has already started.');
    }
    if (this.players.size >= MAX_PLAYERS) {
      throw new Error('Room is full.');
    }
    const player = {
      id,
      name: (name || 'Player').slice(0, 16),
      color: PLAYER_COLORS[this.players.size % PLAYER_COLORS.length],
      socketId,
      connected: true,
      grid: [],
      knownSlots: new Set(),
      score: 0,
      roundScore: null,
    };
    this.players.set(id, player);
    this.order.push(id);
    if (!this.hostId) this.hostId = id;
    this.addLog(`${player.name} joined.`);
    return player;
  }

  disconnectSocket(socketId) {
    const player = [...this.players.values()].find((p) => p.socketId === socketId);
    if (!player) return;
    if (this.phase === 'lobby') {
      this.players.delete(player.id);
      this.order = this.order.filter((id) => id !== player.id);
      if (this.hostId === player.id) {
        this.hostId = this.order[0] || null;
      }
    } else {
      player.connected = false;
      player.socketId = null;
    }
    this.addLog(`${player.name} left.`);
  }

  kickPlayer(hostId, targetId) {
    this.assertHost(hostId);
    if (this.phase !== 'lobby') throw new Error('Can only remove players before the game starts.');
    const player = this.players.get(targetId);
    if (!player) return;
    this.players.delete(targetId);
    this.order = this.order.filter((id) => id !== targetId);
    this.addLog(`${player.name} was removed.`);
  }

  assertHost(id) {
    if (id !== this.hostId) throw new Error('Only the host can do that.');
  }

  updateSettings(hostId, settings) {
    this.assertHost(hostId);
    if (this.phase !== 'lobby') throw new Error('Cannot change settings after the game has started.');
    if (settings && Number.isFinite(settings.targetScore)) {
      this.settings.targetScore = Math.max(20, Math.min(300, Math.round(settings.targetScore)));
    }
  }

  // ---------- round lifecycle ----------

  startGame(hostId) {
    this.assertHost(hostId);
    if (this.phase !== 'lobby') throw new Error('Game already started.');
    if (this.order.length < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} players.`);
    this.round = 0;
    for (const p of this.players.values()) p.score = 0;
    this.beginRound();
  }

  beginRound() {
    this.round += 1;
    this.drawPile = shuffle(buildDeck());
    this.discardPile = [];
    this.caboCallerId = null;
    this.turnsLeftAfterCabo = null;
    this.pendingPower = null;
    this.drawnCard = null;
    this.drawnFrom = null;
    this.peekAcks = new Set();
    this.clearSlapWindow();

    for (const id of this.order) {
      const p = this.players.get(id);
      p.grid = [this.drawPile.pop(), this.drawPile.pop(), this.drawPile.pop(), this.drawPile.pop()];
      p.knownSlots = new Set(INITIAL_KNOWN_SLOTS);
      p.roundScore = null;
    }
    this.discardPile.push(this.drawPile.pop());
    this.phase = 'peek';
    this.addLog(`Round ${this.round} dealt. Take a look at your bottom two cards.`);
    this.broadcast();
  }

  readyForRound(playerId) {
    if (this.phase !== 'peek') throw new Error('Not in the memorize phase.');
    if (!this.players.has(playerId)) throw new Error('Unknown player.');
    this.peekAcks.add(playerId);
    const connectedCount = this.order.filter((id) => this.players.get(id).connected).length;
    if (this.peekAcks.size >= connectedCount) {
      this.phase = 'playing';
      this.currentTurn = (this.round - 1) % this.order.length;
      this.turnState = 'idle';
      this.addLog(`Round ${this.round} begins. ${this.players.get(this.currentPlayerId()).name} goes first.`);
    }
    this.broadcast();
  }

  ensureDrawPile() {
    if (this.drawPile.length > 0) return;
    if (this.discardPile.length <= 1) {
      // extremely unlikely, but avoid a hard crash if the deck is exhausted
      this.drawPile.push({ id: 'filler', suit: 'S', rank: 'A', value: 1, power: null });
      return;
    }
    const top = this.discardPile.pop();
    this.drawPile = shuffle(this.discardPile);
    this.discardPile = [top];
    this.addLog('Draw pile reshuffled from the discard pile.');
  }

  // ---------- turn actions ----------

  drawFromPile(playerId) {
    if (this.phase !== 'playing') throw new Error('Round is not active.');
    if (this.turnState !== 'idle') throw new Error('Finish your current action first.');
    this.requireTurn(playerId);
    this.ensureDrawPile();
    this.drawnCard = this.drawPile.pop();
    this.drawnFrom = 'pile';
    this.turnState = 'drawn';
    this.broadcast();
  }

  drawFromDiscard(playerId) {
    if (this.phase !== 'playing') throw new Error('Round is not active.');
    if (this.turnState !== 'idle') throw new Error('Finish your current action first.');
    this.requireTurn(playerId);
    if (this.discardPile.length === 0) throw new Error('Discard pile is empty.');
    this.drawnCard = this.discardPile.pop();
    this.drawnFrom = 'discard';
    this.turnState = 'drawn';
    this.broadcast();
  }

  swapDrawn(playerId, slotIndex) {
    if (this.turnState !== 'drawn') throw new Error('Draw a card first.');
    this.requireTurn(playerId);
    const player = this.players.get(playerId);
    if (slotIndex < 0 || slotIndex >= player.grid.length) throw new Error('Invalid slot.');
    const old = player.grid[slotIndex];
    player.grid[slotIndex] = this.drawnCard;
    player.knownSlots.add(slotIndex);
    this.discardPile.push(old);
    this.drawnCard = null;
    this.drawnFrom = null;
    this.turnState = 'idle';
    this.openSlapWindow();
    this.advanceTurn();
  }

  discardDrawn(playerId) {
    if (this.turnState !== 'drawn') throw new Error('Draw a card first.');
    if (this.drawnFrom !== 'pile') throw new Error('A card taken from the discard pile must be swapped in.');
    this.requireTurn(playerId);
    const card = this.drawnCard;
    this.discardPile.push(card);
    this.drawnCard = null;
    this.drawnFrom = null;
    this.openSlapWindow();
    if (card.power) {
      this.turnState = 'resolving-power';
      this.pendingPower = { type: card.power, playerId, stage: 0, targets: [] };
      this.addLog(`${this.players.get(playerId).name} discarded ${card.rank}${card.suit} - power available.`);
      this.broadcast();
    } else {
      this.turnState = 'idle';
      this.advanceTurn();
    }
  }

  skipPower(playerId) {
    if (this.turnState !== 'resolving-power' || !this.pendingPower || this.pendingPower.playerId !== playerId) {
      throw new Error('No power to skip.');
    }
    this.pendingPower = null;
    this.turnState = 'idle';
    this.advanceTurn();
  }

  usePowerPeekSelf(playerId, slotIndex) {
    this.assertPower(playerId, 'peek-self');
    const player = this.players.get(playerId);
    if (slotIndex < 0 || slotIndex >= player.grid.length) throw new Error('Invalid slot.');
    player.knownSlots.add(slotIndex);
    this.io.to(player.socketId).emit('peek-result', {
      title: 'You peeked at your own card',
      cards: [{ owner: player.name, card: publicCard(player.grid[slotIndex]) }],
    });
    this.pendingPower = null;
    this.turnState = 'idle';
    this.advanceTurn();
  }

  usePowerPeekOpponent(playerId, targetPlayerId, slotIndex) {
    this.assertPower(playerId, 'peek-opponent');
    const acting = this.players.get(playerId);
    const target = this.players.get(targetPlayerId);
    if (!target || targetPlayerId === playerId) throw new Error('Pick an opponent card.');
    if (slotIndex < 0 || slotIndex >= target.grid.length) throw new Error('Invalid slot.');
    this.io.to(acting.socketId).emit('peek-result', {
      title: `You peeked at ${target.name}'s card`,
      cards: [{ owner: target.name, card: publicCard(target.grid[slotIndex]) }],
    });
    this.pendingPower = null;
    this.turnState = 'idle';
    this.advanceTurn();
  }

  resolveSwapTargets(a, b) {
    const pa = this.players.get(a.playerId);
    const pb = this.players.get(b.playerId);
    if (!pa || !pb) throw new Error('Invalid target.');
    if (a.playerId === b.playerId && a.slot === b.slot) throw new Error('Pick two different cards.');
    if (a.slot < 0 || a.slot >= pa.grid.length) throw new Error('Invalid slot.');
    if (b.slot < 0 || b.slot >= pb.grid.length) throw new Error('Invalid slot.');
    return { pa, pb };
  }

  usePowerBlindSwap(playerId, a, b) {
    this.assertPower(playerId, 'blind-swap');
    const { pa, pb } = this.resolveSwapTargets(a, b);
    const tmp = pa.grid[a.slot];
    pa.grid[a.slot] = pb.grid[b.slot];
    pb.grid[b.slot] = tmp;
    pa.knownSlots.delete(a.slot);
    pb.knownSlots.delete(b.slot);
    this.addLog(`${this.players.get(playerId).name} blind-swapped two cards.`);
    this.pendingPower = null;
    this.turnState = 'idle';
    this.advanceTurn();
  }

  usePowerLookSwapSelect(playerId, a, b) {
    this.assertPower(playerId, 'look-swap');
    const { pa, pb } = this.resolveSwapTargets(a, b);
    const acting = this.players.get(playerId);
    this.pendingPower.stage = 1;
    this.pendingPower.targets = [a, b];
    this.io.to(acting.socketId).emit('peek-result', {
      title: 'Look & Swap - decide whether to swap',
      cards: [
        { owner: pa.name, card: publicCard(pa.grid[a.slot]) },
        { owner: pb.name, card: publicCard(pb.grid[b.slot]) },
      ],
      awaitingSwapDecision: true,
    });
    this.broadcast();
  }

  usePowerLookSwapDecide(playerId, doSwap) {
    if (
      this.turnState !== 'resolving-power' ||
      !this.pendingPower ||
      this.pendingPower.playerId !== playerId ||
      this.pendingPower.type !== 'look-swap' ||
      this.pendingPower.stage !== 1
    ) {
      throw new Error('No swap decision pending.');
    }
    const [a, b] = this.pendingPower.targets;
    if (doSwap) {
      const { pa, pb } = this.resolveSwapTargets(a, b);
      const tmp = pa.grid[a.slot];
      pa.grid[a.slot] = pb.grid[b.slot];
      pb.grid[b.slot] = tmp;
      pa.knownSlots.delete(a.slot);
      pb.knownSlots.delete(b.slot);
      this.addLog(`${this.players.get(playerId).name} looked at two cards and swapped them.`);
    } else {
      this.addLog(`${this.players.get(playerId).name} looked at two cards and chose not to swap.`);
    }
    this.pendingPower = null;
    this.turnState = 'idle';
    this.advanceTurn();
  }

  assertPower(playerId, type) {
    if (this.turnState !== 'resolving-power' || !this.pendingPower) throw new Error('No power active.');
    if (this.pendingPower.playerId !== playerId) throw new Error('Not your power to use.');
    if (this.pendingPower.type !== type) throw new Error('Wrong power type.');
    if (this.pendingPower.stage !== 0) throw new Error('Power already in progress.');
  }

  // ---------- slap rule ----------

  openSlapWindow() {
    this.clearSlapWindow();
    this.slapWindow.active = true;
    this.slapWindow.timeout = setTimeout(() => {
      this.slapWindow.active = false;
      this.broadcast();
    }, SLAP_WINDOW_MS);
  }

  clearSlapWindow() {
    if (this.slapWindow.timeout) clearTimeout(this.slapWindow.timeout);
    this.slapWindow = { active: false, timeout: null };
  }

  slapDiscard(playerId, slotIndex) {
    if (this.phase !== 'playing' && this.phase !== 'peek') {
      // slapping is only meaningful during active play
    }
    if (this.phase !== 'playing') throw new Error('Cannot slap right now.');
    if (!this.slapWindow.active) throw new Error('Too slow - the moment has passed.');
    const player = this.players.get(playerId);
    if (!player) throw new Error('Unknown player.');
    if (slotIndex < 0 || slotIndex >= player.grid.length) throw new Error('Invalid slot.');
    const top = this.discardPile[this.discardPile.length - 1];
    const card = player.grid[slotIndex];
    if (!top || card.rank !== top.rank) {
      // wrong slap: penalty card added to the grid
      this.ensureDrawPile();
      const penalty = this.drawPile.pop();
      player.grid.push(penalty);
      this.addLog(`${player.name} slapped wrong and picked up a penalty card.`);
      this.broadcast();
      return;
    }
    // correct slap
    player.grid.splice(slotIndex, 1);
    player.knownSlots = new Set(
      [...player.knownSlots]
        .filter((i) => i !== slotIndex)
        .map((i) => (i > slotIndex ? i - 1 : i))
    );
    this.discardPile.push(card);
    this.addLog(`${player.name} slapped a matching ${card.rank}!`);
    this.openSlapWindow();
    this.broadcast();
  }

  // ---------- cabo & scoring ----------

  callCabo(playerId) {
    if (this.phase !== 'playing') throw new Error('Round is not active.');
    if (this.turnState !== 'idle') throw new Error('Finish your current action first.');
    this.requireTurn(playerId);
    if (this.caboCallerId) throw new Error('Cabo has already been called.');
    this.caboCallerId = playerId;
    this.turnsLeftAfterCabo = this.order.length - 1;
    this.addLog(`${this.players.get(playerId).name} called Cabo! Final turns for everyone else.`);
    this.advanceTurn();
  }

  advanceTurn() {
    this.turnState = 'idle';
    this.drawnCard = null;
    this.drawnFrom = null;
    this.pendingPower = null;

    if (this.caboCallerId !== null) {
      this.turnsLeftAfterCabo -= 1;
      if (this.turnsLeftAfterCabo <= 0) {
        this.startReveal();
        return;
      }
    }

    let guard = 0;
    do {
      this.currentTurn = (this.currentTurn + 1) % this.order.length;
      guard += 1;
    } while (!this.players.get(this.currentPlayerId()).connected && guard <= this.order.length);

    this.broadcast();
  }

  startReveal() {
    this.phase = 'reveal';
    this.clearSlapWindow();
    for (const id of this.order) {
      const p = this.players.get(id);
      p.roundScore = p.grid.reduce((sum, c) => sum + (c ? c.value : 0), 0);
    }
    if (this.caboCallerId) {
      const caller = this.players.get(this.caboCallerId);
      const others = this.order.filter((id) => id !== this.caboCallerId).map((id) => this.players.get(id));
      const failed = others.some((p) => p.roundScore <= caller.roundScore);
      if (failed) {
        caller.roundScore += CABO_PENALTY;
        this.addLog(`${caller.name} did not have the lowest score - +${CABO_PENALTY} penalty!`);
      } else {
        this.addLog(`${caller.name} called it perfectly and dodges the penalty.`);
      }
    }
    for (const id of this.order) {
      const p = this.players.get(id);
      p.score += p.roundScore;
    }
    const over = this.order.some((id) => this.players.get(id).score >= this.settings.targetScore);
    if (over) {
      this.phase = 'gameover';
      const winner = this.order
        .map((id) => this.players.get(id))
        .reduce((best, p) => (p.score < best.score ? p : best));
      this.addLog(`Game over! ${winner.name} wins with ${winner.score} points.`);
    } else {
      this.addLog(`Round ${this.round} complete.`);
    }
    this.broadcast();
  }

  startNextRound(hostId) {
    this.assertHost(hostId);
    if (this.phase !== 'reveal') throw new Error('Round has not ended yet.');
    this.beginRound();
  }

  restartGame(hostId) {
    this.assertHost(hostId);
    if (this.phase !== 'gameover') throw new Error('Game is still in progress.');
    this.phase = 'lobby';
    this.round = 0;
    for (const p of this.players.values()) {
      p.score = 0;
      p.roundScore = null;
      p.grid = [];
      p.knownSlots = new Set();
    }
    this.addLog('Returned to lobby for a new game.');
    this.broadcast();
  }

  // ---------- serialization ----------

  getPublicState(forPlayerId) {
    const revealAll = this.phase === 'reveal' || this.phase === 'gameover';
    const players = this.order.map((id) => {
      const p = this.players.get(id);
      const grid = p.grid.map((card, idx) => {
        if (!card) return null;
        if (revealAll) return publicCard(card);
        if (id === forPlayerId && p.knownSlots.has(idx)) return publicCard(card);
        return { hidden: true };
      });
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        connected: p.connected,
        isHost: id === this.hostId,
        cardCount: p.grid.length,
        grid,
        score: p.score,
        roundScore: p.roundScore,
      };
    });

    let drawnCardForMe = null;
    if (this.turnState === 'drawn' && this.currentPlayerId() === forPlayerId) {
      drawnCardForMe = publicCard(this.drawnCard);
    } else if (this.turnState === 'drawn' && this.drawnFrom === 'discard') {
      drawnCardForMe = publicCard(this.drawnCard);
    }

    let power = null;
    if (this.pendingPower) {
      power = {
        type: this.pendingPower.type,
        playerId: this.pendingPower.playerId,
        stage: this.pendingPower.stage,
        mine: this.pendingPower.playerId === forPlayerId,
      };
    }

    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      settings: this.settings,
      hostId: this.hostId,
      players,
      discardTop: this.discardPile.length ? publicCard(this.discardPile[this.discardPile.length - 1]) : null,
      drawPileCount: this.drawPile.length,
      currentTurn: this.order.length ? this.currentPlayerId() : null,
      turnState: this.turnState,
      drawnFrom: this.turnState === 'drawn' ? this.drawnFrom : null,
      drawnCard: drawnCardForMe,
      power,
      caboCallerId: this.caboCallerId,
      slapWindowActive: this.slapWindow.active,
      peekReadyCount: this.peekAcks.size,
      iAmReady: this.peekAcks.has(forPlayerId),
      log: this.log.slice(-15),
      you: forPlayerId,
    };
  }

  broadcast() {
    for (const p of this.players.values()) {
      if (p.connected && p.socketId) {
        this.io.to(p.socketId).emit('state', this.getPublicState(p.id));
      }
    }
  }
}

module.exports = { Room, MIN_PLAYERS, MAX_PLAYERS };
