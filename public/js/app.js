(() => {
  'use strict';

  // ---------- identity / storage ----------

  const LS = {
    get playerId() {
      let id = localStorage.getItem('kaabo_playerId');
      if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : `p${Date.now()}${Math.random().toString(16).slice(2)}`);
        localStorage.setItem('kaabo_playerId', id);
      }
      return id;
    },
    get name() { return localStorage.getItem('kaabo_name') || ''; },
    set name(v) { localStorage.setItem('kaabo_name', v); },
    get roomCode() { return localStorage.getItem('kaabo_roomCode') || ''; },
    set roomCode(v) { v ? localStorage.setItem('kaabo_roomCode', v) : localStorage.removeItem('kaabo_roomCode'); },
  };

  const me = { id: LS.playerId };
  const socket = io();

  // ---------- small DOM helpers ----------

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function showScreen(id) {
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  }

  function toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'error' : ''}`.trim();
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function el(tag, className, children) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (children) children.forEach((c) => c && n.appendChild(c));
    return n;
  }

  const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const suitColor = (suit) => (suit === 'H' || suit === 'D' ? 'red' : 'black');

  function cardEl(card, { size = '', tappable = false, selected = false, extraClass = '' } = {}) {
    const known = card && !card.hidden;
    const wrap = el('div', `card ${size} ${tappable ? 'tappable' : ''} ${selected ? 'selectable' : ''} ${known ? 'flipped' : ''} ${extraClass}`.replace(/\s+/g, ' ').trim());
    const inner = el('div', 'card-inner');
    const back = el('div', 'card-back');
    const front = el('div', `card-front ${known ? suitColor(card.suit) : ''}`);
    if (known) {
      front.appendChild(el('div', 'rank', [document.createTextNode(card.rank)]));
      front.appendChild(el('div', 'suit', [document.createTextNode(SUIT_SYMBOL[card.suit])]));
    }
    inner.appendChild(back);
    inner.appendChild(front);
    wrap.appendChild(inner);
    return wrap;
  }

  function faceUpCardEl(card, size = '') {
    const wrap = el('div', `card card-face-up ${size}`.trim());
    const front = el('div', `card-front ${card ? suitColor(card.suit) : ''}`);
    if (card) {
      front.appendChild(el('div', 'rank', [document.createTextNode(card.rank)]));
      front.appendChild(el('div', 'suit', [document.createTextNode(SUIT_SYMBOL[card.suit])]));
    }
    wrap.appendChild(front);
    return wrap;
  }

  // ---------- state ----------

  let latest = null;
  let lastPhase = null;
  let lobbyInfoLoaded = false;
  let power = { mode: null, a: null, b: null }; // local staging for blind-swap / look-swap target picking

  function myPlayer(state) {
    return state.players.find((p) => p.id === state.you);
  }
  function isHost(state) {
    return state.hostId === state.you;
  }

  // ---------- round table geometry ----------

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // state.players is already server-ordered by turn; rotate it so "you" is
  // index 0, which keeps the seating clockwise-from-you in real turn order -
  // like everyone sitting around a physical table.
  function seatOrder(state) {
    const myIndex = state.players.findIndex((p) => p.id === state.you);
    if (myIndex < 0) return state.players;
    return state.players.slice(myIndex).concat(state.players.slice(0, myIndex));
  }

  function seatPosition(i, n) {
    const angleDeg = 180 + (360 / n) * i;
    const rad = (angleDeg * Math.PI) / 180;
    const cx = 50, cy = 50, rx = 41, ry = 39;
    return { x: cx + rx * Math.sin(rad), y: cy - ry * Math.cos(rad) };
  }

  function renderSeats(state) {
    const layer = $('#seats-layer');
    layer.innerHTML = '';
    const rotated = seatOrder(state);
    const n = rotated.length;
    for (let i = 1; i < n; i++) {
      const p = rotated[i];
      const isTurn = p.id === state.currentTurn;
      const { x, y } = seatPosition(i, n);
      const seat = el('div', `seat ${isTurn ? 'active-turn' : ''} ${!p.connected ? 'offline' : ''}`.replace(/\s+/g, ' ').trim());
      seat.style.left = `${x}%`;
      seat.style.top = `${y}%`;
      seat.dataset.playerId = p.id;

      const avatar = el('div', 'seat-avatar', [document.createTextNode(p.name.charAt(0).toUpperCase())]);
      avatar.style.background = p.color;
      avatar.appendChild(el('span', 'seat-cardcount', [document.createTextNode(String(p.cardCount))]));
      seat.appendChild(avatar);

      seat.appendChild(el('div', 'seat-name', [document.createTextNode(p.name)]));

      const meta = el('div', 'seat-meta');
      if (isTurn) meta.appendChild(el('span', 'seat-turn-badge', [document.createTextNode('Turn')]));
      meta.appendChild(el('span', '', [document.createTextNode(`${p.score} pts`)]));
      seat.appendChild(meta);

      layer.appendChild(seat);
    }
  }

  function seatAvatarRect(playerId, state) {
    if (playerId === state.you) {
      const el_ = $('#self-area');
      return el_ ? el_.getBoundingClientRect() : null;
    }
    const node = document.querySelector(`.seat[data-player-id="${playerId}"] .seat-avatar`);
    return node ? node.getBoundingClientRect() : null;
  }

  function pileRect(which) {
    const node = $(which === 'draw' ? '#pile-draw' : '#pile-discard');
    return node ? node.getBoundingClientRect() : null;
  }

  function flashImpact(target) {
    if (reducedMotion || !target) return;
    target.classList.add('impact');
    setTimeout(() => target.classList.remove('impact'), 400);
  }

  // A rect from an element inside a display:none ancestor (e.g. a different,
  // inactive .screen) comes back as all-zero rather than null - treat that
  // as "not currently on screen" so we never animate from the corner.
  function isRenderedRect(r) {
    return !!r && (r.width > 0 || r.height > 0) && (r.top !== 0 || r.left !== 0 || r.width !== 0 || r.height !== 0);
  }

  // Animates a ghost card flying between two screen rects using the Web
  // Animations API - purely cosmetic, never touches game state.
  function flyGhost(fromRect, toRect, { faceUp = false, card = null, duration = 520, delay = 0, rotate = 0 } = {}) {
    if (reducedMotion || !isRenderedRect(fromRect) || !isRenderedRect(toRect)) return Promise.resolve();
    const ghost = el('div', `card ghost-card ${faceUp ? 'flipped' : ''}`.trim());
    const inner = el('div', 'card-inner');
    const back = el('div', 'card-back');
    const front = el('div', `card-front ${faceUp && card ? suitColor(card.suit) : ''}`);
    if (faceUp && card) {
      front.appendChild(el('div', 'rank', [document.createTextNode(card.rank)]));
      front.appendChild(el('div', 'suit', [document.createTextNode(SUIT_SYMBOL[card.suit])]));
    }
    inner.appendChild(back);
    inner.appendChild(front);
    ghost.appendChild(inner);
    document.body.appendChild(ghost);

    const fromCx = fromRect.left + fromRect.width / 2;
    const fromCy = fromRect.top + fromRect.height / 2;
    const toCx = toRect.left + toRect.width / 2;
    const toCy = toRect.top + toRect.height / 2;
    ghost.style.left = `${fromCx - 34}px`;
    ghost.style.top = `${fromCy - 48}px`;
    const dx = toCx - fromCx;
    const dy = toCy - fromCy;

    return new Promise((resolve) => {
      const anim = ghost.animate(
        [
          { transform: 'translate(0px, 0px) rotate(0deg) scale(1)', offset: 0 },
          { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 30}px) rotate(${rotate * 0.5}deg) scale(1.04)`, offset: 0.55 },
          { transform: `translate(${dx}px, ${dy}px) rotate(${rotate}deg) scale(1)`, offset: 1 },
        ],
        { duration, delay, easing: 'cubic-bezier(.3,.6,.35,1)', fill: 'forwards' }
      );
      anim.onfinish = () => { ghost.remove(); resolve(); };
    });
  }

  // ---------- transition-triggered animation ----------

  function detectAndAnimate(prev, next) {
    if (!prev || reducedMotion) return;
    if (!next.players || !next.players.length) return;
    if (next.phase !== 'playing') return;

    if (prev.phase === 'playing' && prev.turnState === 'idle' && next.turnState === 'drawn' && next.currentTurn) {
      animateDraw(next, next.currentTurn);
    }
    if (prev.phase === 'playing' && prev.turnState === 'drawn' && next.turnState !== 'drawn' && prev.currentTurn) {
      animateDiscard(next, prev.currentTurn);
    }

    const lastLog = next.log && next.log.length ? next.log[next.log.length - 1] : null;
    const prevLastLog = prev.log && prev.log.length ? prev.log[prev.log.length - 1] : null;
    if (lastLog && lastLog.text.includes('slapped a matching') && (!prevLastLog || lastLog.ts !== prevLastLog.ts)) {
      const name = lastLog.text.split(' slapped')[0];
      const player = next.players.find((p) => p.name === name);
      if (player) animateSlap(next, player.id);
    }
  }

  function animateDraw(state, playerId) {
    const drawnFromDiscard = state.drawnFrom === 'discard';
    const from = pileRect(drawnFromDiscard ? 'discard' : 'draw');
    const to = seatAvatarRect(playerId, state);
    const faceUp = drawnFromDiscard && !!state.drawnCard;
    flyGhost(from, to, { faceUp, card: state.drawnCard, rotate: 6 }).then(() => {
      flashImpact(playerId === state.you ? $('#self-area') : document.querySelector(`.seat[data-player-id="${playerId}"]`));
    });
  }

  function animateDiscard(state, playerId) {
    const from = seatAvatarRect(playerId, state);
    const to = pileRect('discard');
    flyGhost(from, to, { faceUp: true, card: state.discardTop, rotate: -8 }).then(() => {
      flashImpact($('#pile-discard'));
    });
  }

  function animateSlap(state, playerId) {
    const from = seatAvatarRect(playerId, state);
    const to = pileRect('discard');
    flyGhost(from, to, { faceUp: true, card: state.discardTop, duration: 320, rotate: -14 }).then(() => {
      flashImpact($('#pile-discard'));
    });
  }

  function launchConfetti() {
    if (reducedMotion) return;
    const layer = $('#confetti-layer');
    if (!layer) return;
    layer.innerHTML = '';
    const colors = ['#e8c874', '#e0556b', '#6fce9a', '#7dc4e0', '#a78bfa', '#f0d99a'];
    for (let i = 0; i < 60; i++) {
      const piece = el('div', 'confetti-piece');
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = colors[i % colors.length];
      piece.style.animationDuration = `${2.2 + Math.random() * 1.6}s`;
      piece.style.animationDelay = `${Math.random() * 0.6}s`;
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      layer.appendChild(piece);
    }
    setTimeout(() => { layer.innerHTML = ''; }, 4200);
  }

  // ---------- socket wiring ----------

  socket.on('connect', () => {
    if (LS.roomCode) {
      socket.emit('rejoin-room', { roomCode: LS.roomCode, playerId: me.id }, (ack) => {
        if (!ack.ok) {
          LS.roomCode = '';
          showScreen('screen-landing');
        }
      });
    }
  });

  socket.on('state', (state) => {
    const prev = latest;
    latest = state;
    LS.roomCode = state.code;
    render(state);
    detectAndAnimate(prev, state);
  });

  socket.on('action-error', (p) => toast(p.message, 'error'));

  socket.on('peek-result', (p) => {
    const body = $('#peek-result-body');
    body.innerHTML = '';
    body.appendChild(el('h3', 'power-title', [document.createTextNode(p.title)]));
    const row = el('div', 'peek-cards');
    p.cards.forEach((c) => {
      const block = el('div', 'peek-card-block');
      block.appendChild(faceUpCardEl(c.card));
      block.appendChild(el('span', '', [document.createTextNode(c.owner)]));
      row.appendChild(block);
    });
    body.appendChild(row);

    const actions = el('div', 'modal-actions');
    if (p.awaitingSwapDecision) {
      const yes = el('button', 'btn btn-primary', [document.createTextNode('Swap them')]);
      const no = el('button', 'btn btn-ghost', [document.createTextNode("Don't swap")]);
      yes.onclick = () => { socket.emit('power-look-swap-decide', { swap: true }); closeModal('peek-result-modal'); };
      no.onclick = () => { socket.emit('power-look-swap-decide', { swap: false }); closeModal('peek-result-modal'); };
      actions.appendChild(no);
      actions.appendChild(yes);
    } else {
      const ok = el('button', 'btn btn-primary', [document.createTextNode('Got it')]);
      ok.onclick = () => closeModal('peek-result-modal');
      actions.appendChild(ok);
    }
    body.appendChild(actions);
    openModal('peek-result-modal');
  });

  function openModal(id) { $(`#${id}`).classList.remove('hidden'); }
  function closeModal(id) { $(`#${id}`).classList.add('hidden'); }

  // ---------- landing / entry ----------

  let entryMode = 'host';

  $('#btn-go-host').onclick = () => {
    entryMode = 'host';
    $('#entry-title').textContent = 'Host a Game';
    $('#field-room-code').classList.add('hidden');
    $('#input-name').value = LS.name;
    $('#entry-error').textContent = '';
    showScreen('screen-entry');
  };

  $('#btn-go-join').onclick = () => {
    entryMode = 'join';
    $('#entry-title').textContent = 'Join a Game';
    $('#field-room-code').classList.remove('hidden');
    $('#input-name').value = LS.name;
    $('#input-room-code').value = '';
    $('#entry-error').textContent = '';
    showScreen('screen-entry');
    fetch('/api/host-info').then((r) => r.json()).then((info) => {
      if (info.openRoomCode) $('#input-room-code').value = info.openRoomCode;
    }).catch(() => {});
  };

  $('#btn-entry-back').onclick = () => showScreen('screen-landing');

  // Mobile keyboards don't always honor autocapitalize consistently -
  // force it live so what you see matches what gets submitted.
  $('#input-room-code').addEventListener('input', (e) => {
    const pos = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase();
    e.target.setSelectionRange(pos, pos);
  });

  // Enter key on either entry field submits, so the mobile "Go"/"Next"
  // key on the keyboard actually does something useful.
  $('#input-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (entryMode === 'join') $('#input-room-code').focus();
      else $('#btn-entry-submit').click();
    }
  });
  $('#input-room-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-entry-submit').click();
  });

  $('#btn-entry-submit').onclick = () => {
    const name = $('#input-name').value.trim();
    if (!name) { $('#entry-error').textContent = 'Enter your name.'; return; }
    LS.name = name;
    if (entryMode === 'host') {
      socket.emit('create-room', { playerId: me.id, name }, (ack) => {
        if (!ack.ok) { $('#entry-error').textContent = ack.error; return; }
        LS.roomCode = ack.code;
        lobbyInfoLoaded = false;
      });
    } else {
      const code = $('#input-room-code').value.trim().toUpperCase();
      if (code.length < 4) { $('#entry-error').textContent = 'Enter the 4-letter room code.'; return; }
      socket.emit('join-room', { roomCode: code, playerId: me.id, name }, (ack) => {
        if (!ack.ok) { $('#entry-error').textContent = ack.error; return; }
        LS.roomCode = ack.code;
        lobbyInfoLoaded = false;
      });
    }
  };

  $('#btn-show-rules').onclick = () => openModal('rules-modal');
  $('#btn-lobby-rules').onclick = () => openModal('rules-modal');
  $('#btn-close-rules').onclick = () => closeModal('rules-modal');

  // ---------- lobby ----------

  $('#input-target-score').addEventListener('change', (e) => {
    if (!latest || !isHost(latest)) return;
    socket.emit('update-settings', { targetScore: Number(e.target.value) });
  });

  $('#btn-start-game').onclick = () => {
    socket.emit('start-game', {}, (ack) => { if (!ack.ok) toast(ack.error, 'error'); });
  };

  function renderLobby(state) {
    $('#lobby-room-code').textContent = state.code;
    $('#lobby-player-count').textContent = state.players.length;

    const list = $('#lobby-player-list');
    list.innerHTML = '';
    state.players.forEach((p) => {
      const li = el('li');
      li.appendChild(el('span', 'dot', [])).style.background = p.color;
      const name = el('span', 'player-name', [document.createTextNode(p.name + (p.id === state.you ? ' (You)' : ''))]);
      li.appendChild(name);
      if (p.isHost) li.appendChild(el('span', 'player-tag', [document.createTextNode('HOST')]));
      if (!p.connected) li.appendChild(el('span', 'offline-tag', [document.createTextNode('offline')]));
      if (isHost(state) && p.id !== state.you) {
        const kick = el('button', 'btn btn-sm btn-ghost', [document.createTextNode('Remove')]);
        kick.onclick = () => socket.emit('kick-player', { targetId: p.id });
        li.appendChild(kick);
      }
      list.appendChild(li);
    });

    const amHost = isHost(state);
    $('#lobby-join-info').classList.toggle('hidden', !amHost);
    $('#lobby-host-settings').classList.toggle('hidden', !amHost);
    $('#btn-start-game').classList.toggle('hidden', !amHost);
    $('#lobby-waiting-text').classList.toggle('hidden', amHost);
    $('#btn-start-game').disabled = state.players.length < 2;
    $('#input-target-score').value = state.settings.targetScore;

    if (amHost && !lobbyInfoLoaded) {
      lobbyInfoLoaded = true;
      fetch('/api/host-info').then((r) => r.json()).then((info) => {
        const box = $('#lobby-addresses');
        box.innerHTML = '';
        if (!info.addresses.length) {
          box.appendChild(el('p', 'hint', [document.createTextNode('Could not detect a WiFi/hotspot address on this device.')]));
        }
        info.addresses.forEach((a) => {
          box.appendChild(el('code', '', [document.createTextNode(`http://${a}:${info.port}`)]));
        });
      }).catch(() => {});
    }
    showScreen('screen-lobby');
  }

  // ---------- peek ----------

  $('#btn-ready').onclick = () => socket.emit('ready', {}, () => {});

  let dealAnimatedRound = null;

  function renderPeek(state) {
    $('#peek-round').textContent = state.round;
    const me_ = myPlayer(state);
    const grid = $('#peek-grid');
    grid.innerHTML = '';
    const isFirstRenderThisRound = dealAnimatedRound !== state.round;
    dealAnimatedRound = state.round;
    me_.grid.forEach((card, i) => {
      const node = cardEl(card);
      if (isFirstRenderThisRound && !reducedMotion) {
        node.classList.add('deal-in');
        node.style.animationDelay = `${i * 90}ms`;
      }
      grid.appendChild(node);
    });
    const connectedCount = state.players.filter((p) => p.connected).length;
    $('#peek-ready-count').textContent = `${state.peekReadyCount}/${connectedCount} ready`;
    $('#btn-ready').disabled = state.iAmReady;
    $('#btn-ready').textContent = state.iAmReady ? 'Waiting for others...' : "I'm Ready";
    showScreen('screen-peek');
  }

  // ---------- game ----------

  $('#btn-open-log').onclick = () => { renderLog(); openPanel('log-panel'); };
  $('#btn-close-log').onclick = () => closePanel('log-panel');
  $('#btn-open-scores').onclick = () => { renderScoreList('#score-list', latest); openPanel('scores-panel'); };
  $('#btn-close-scores').onclick = () => closePanel('scores-panel');

  function openPanel(id) { $(`#${id}`).classList.remove('hidden'); }
  function closePanel(id) { $(`#${id}`).classList.add('hidden'); }

  function renderLog() {
    const list = $('#log-list');
    list.innerHTML = '';
    if (!latest) return;
    [...latest.log].reverse().forEach((entry) => {
      list.appendChild(el('li', '', [document.createTextNode(entry.text)]));
    });
  }

  function renderScoreList(selector, state) {
    const list = $(selector);
    list.innerHTML = '';
    [...state.players].sort((a, b) => a.score - b.score).forEach((p, i) => {
      const li = el('li');
      const left = el('span', '', [document.createTextNode(`${i + 1}. ${p.name}${p.id === state.you ? ' (You)' : ''}`)]);
      const right = el('span', 'score-value', [document.createTextNode(String(p.score))]);
      li.appendChild(left);
      li.appendChild(right);
      list.appendChild(li);
    });
  }

  function onSelfCardTap(state, slot) {
    if (state.slapWindowActive) {
      socket.emit('slap', { slot });
      return;
    }
    const isMyTurn = state.currentTurn === state.you;
    if (isMyTurn && state.turnState === 'drawn') {
      socket.emit('swap-drawn', { slot }, (ack) => { if (!ack.ok) toast(ack.error, 'error'); });
    }
  }

  const POWER_LABELS = {
    'peek-self': 'Peek at your own card',
    'peek-opponent': "Peek at an opponent's card",
    'blind-swap': 'Blind swap two cards',
    'look-swap': 'Look & Swap two cards',
  };

  function renderGame(state) {
    $('#game-round').textContent = state.round;
    const me_ = myPlayer(state);
    const isMyTurn = state.currentTurn === state.you;
    const iAmSlapping = state.slapWindowActive;

    renderSeats(state);

    // discard / draw piles
    const discardHolder = $('#discard-card-holder');
    discardHolder.innerHTML = '';
    discardHolder.appendChild(faceUpCardEl(state.discardTop));
    $('#draw-count').textContent = state.drawPileCount;
    const canDraw = isMyTurn && state.turnState === 'idle';
    $('#pile-draw').classList.toggle('active-pile', canDraw);
    $('#pile-discard').classList.toggle('active-pile', canDraw && !!state.discardTop);

    // drawn card preview
    const drawnPreview = $('#drawn-preview');
    if (isMyTurn && state.turnState === 'drawn' && state.drawnCard) {
      drawnPreview.classList.remove('hidden');
      const holder = $('#drawn-preview-card');
      holder.innerHTML = '';
      holder.appendChild(faceUpCardEl(state.drawnCard));
    } else {
      drawnPreview.classList.add('hidden');
    }

    // ---- status bar: single, unambiguous "what do I do right now" ----
    const statusBar = $('#status-bar');
    const headlineEl = $('#status-headline');
    const subEl = $('#status-sub');
    let headline = '';
    let sub = '';
    let stateClass = 'state-waiting';
    const caboNote = (extra) => {
      if (!state.caboCallerId) return extra;
      const caller = state.players.find((p) => p.id === state.caboCallerId);
      const who = caller.id === state.you ? 'You' : caller.name;
      return `${extra ? extra + ' • ' : ''}${who} called Kaabo - final round!`;
    };

    if (iAmSlapping) {
      headline = 'Slap Window Open!';
      sub = 'Anyone with a matching card can tap it in their row below - be quick.';
      stateClass = 'state-slap';
    } else if (state.turnState === 'resolving-power' && state.power) {
      const actor = state.players.find((p) => p.id === state.power.playerId);
      if (state.power.mine) {
        headline = POWER_LABELS[state.power.type] || 'Resolve your power';
        sub = state.power.type === 'look-swap' && state.power.stage === 1
          ? 'Check the popup to decide.'
          : 'Choose from the cards below.';
        stateClass = 'state-power';
      } else {
        headline = `${actor.name} is using a power`;
        sub = 'Hang tight...';
      }
    } else if (isMyTurn && state.turnState === 'idle') {
      headline = 'Your Turn';
      sub = caboNote('Tap the Draw Pile or the Discard Pile below.');
      stateClass = 'state-your-turn';
    } else if (isMyTurn && state.turnState === 'drawn') {
      if (state.drawnFrom === 'discard') {
        headline = 'Must Swap It In';
        sub = 'Tap one of your cards below to place it (no discarding this one).';
      } else {
        headline = 'You Drew a Card';
        sub = 'Tap one of your cards to swap it in, or tap Discard It below.';
      }
      stateClass = 'state-decide';
    } else {
      const actor = state.players.find((p) => p.id === state.currentTurn);
      headline = actor ? `${actor.name}'s Turn` : 'Waiting...';
      sub = actor && !actor.connected
        ? `${actor.name} is disconnected - their turn will be skipped shortly.`
        : 'Drawing or deciding what to do...';
      sub = caboNote(sub);
    }
    headlineEl.textContent = headline;
    subEl.textContent = sub;
    statusBar.className = `status-bar ${stateClass}`;

    // self area
    $('#self-name').textContent = me_.name + ' (You)';
    $('#self-score').textContent = me_.score;
    const selfArea = $('#self-area');
    selfArea.classList.toggle('slap-glow', iAmSlapping);
    selfArea.classList.toggle('my-turn-glow', !iAmSlapping && isMyTurn);
    const grid = $('#self-grid');
    grid.innerHTML = '';
    const swapMode = isMyTurn && state.turnState === 'drawn';
    me_.grid.forEach((c, idx) => {
      const tappable = iAmSlapping || swapMode;
      const extraClass = iAmSlapping ? 'slap-target' : (swapMode ? 'swap-target' : '');
      const cardNode = cardEl(c, { tappable, extraClass });
      cardNode.onclick = () => onSelfCardTap(state, idx);
      grid.appendChild(cardNode);
    });
    const selfHint = $('#self-hint');
    if (iAmSlapping) {
      selfHint.textContent = 'Think you have a match? Tap it now!';
      selfHint.classList.remove('hidden');
    } else if (swapMode) {
      selfHint.textContent = 'Tap a card above to swap your drawn card into that slot.';
      selfHint.classList.remove('hidden');
    } else {
      selfHint.classList.add('hidden');
    }

    // action bar
    const bar = $('#action-bar');
    bar.innerHTML = '';
    if (isMyTurn && state.turnState === 'idle') {
      const drawPileBtn = el('button', 'btn btn-primary', [document.createTextNode('Draw Pile')]);
      drawPileBtn.onclick = () => socket.emit('draw-pile', {}, (ack) => { if (!ack.ok) toast(ack.error, 'error'); });
      const drawDiscardBtn = el('button', 'btn btn-ghost', [document.createTextNode('Draw Discard')]);
      drawDiscardBtn.disabled = !state.discardTop;
      drawDiscardBtn.onclick = () => socket.emit('draw-discard', {}, (ack) => { if (!ack.ok) toast(ack.error, 'error'); });
      const caboBtn = el('button', 'btn btn-ghost', [document.createTextNode('Call Kaabo')]);
      caboBtn.disabled = !!state.caboCallerId;
      caboBtn.onclick = () => socket.emit('call-cabo', {}, (ack) => { if (!ack.ok) toast(ack.error, 'error'); });
      bar.appendChild(drawPileBtn);
      bar.appendChild(drawDiscardBtn);
      bar.appendChild(caboBtn);
    } else if (isMyTurn && state.turnState === 'drawn' && state.drawnFrom === 'pile') {
      const discardBtn = el('button', 'btn btn-primary', [document.createTextNode('Discard It')]);
      discardBtn.onclick = () => socket.emit('discard-drawn', {}, (ack) => { if (!ack.ok) toast(ack.error, 'error'); });
      bar.appendChild(discardBtn);
    }

    // pile taps also work as a shortcut for the draw buttons
    $('#pile-draw').onclick = () => {
      if (isMyTurn && state.turnState === 'idle') socket.emit('draw-pile', {}, (ack) => { if (!ack.ok) toast(ack.error, 'error'); });
    };
    $('#pile-discard').onclick = () => {
      if (isMyTurn && state.turnState === 'idle') socket.emit('draw-discard', {}, (ack) => { if (!ack.ok) toast(ack.error, 'error'); });
    };

    // power modal
    if (state.turnState === 'resolving-power' && state.power && state.power.mine) {
      renderPowerModal(state);
    } else {
      closeModal('power-modal');
    }

    showScreen('screen-game');
  }

  // ---------- power resolution ----------

  function slotButtonRow(state, playerFilter, onPick, isPicked) {
    const wrap = el('div', 'target-list');
    state.players.filter(playerFilter).forEach((p) => {
      const group = el('div', 'target-group');
      group.appendChild(el('div', 'target-group-name', [document.createTextNode(p.id === state.you ? 'Your cards' : p.name)]));
      const cardsRow = el('div', 'target-cards');
      p.grid.forEach((c, idx) => {
        if (!c) return;
        const picked = isPicked ? isPicked(p.id, idx) : false;
        const btn = cardEl(c, { size: 'small', tappable: true, extraClass: picked ? 'picked' : '' });
        const block = el('div', 'target-card-block', [btn, el('span', '', [document.createTextNode(`Slot ${idx + 1}`)])]);
        btn.onclick = () => onPick(p.id, idx);
        cardsRow.appendChild(block);
      });
      group.appendChild(cardsRow);
      wrap.appendChild(group);
    });
    return wrap;
  }

  function renderPowerModal(state) {
    const body = $('#power-modal-body');
    body.innerHTML = '';
    const type = state.power.type;

    const skipBtn = () => {
      const b = el('button', 'btn btn-ghost btn-sm', [document.createTextNode('Skip power')]);
      b.onclick = () => socket.emit('skip-power', {}, () => { power = { mode: null, a: null, b: null }; });
      return b;
    };

    if (type === 'peek-self') {
      body.appendChild(el('h3', 'power-title', [document.createTextNode('Peek at your own card')]));
      body.appendChild(el('p', 'power-desc', [document.createTextNode('Choose one of your cards to look at.')]));
      body.appendChild(slotButtonRow(state, (p) => p.id === state.you, (playerId, slot) => {
        socket.emit('power-peek-self', { slot });
      }));
      body.appendChild(skipBtn());
    } else if (type === 'peek-opponent') {
      body.appendChild(el('h3', 'power-title', [document.createTextNode("Peek at an opponent's card")]));
      body.appendChild(el('p', 'power-desc', [document.createTextNode('Choose a card to look at.')]));
      body.appendChild(slotButtonRow(state, (p) => p.id !== state.you, (playerId, slot) => {
        socket.emit('power-peek-opponent', { targetId: playerId, slot });
      }));
      body.appendChild(skipBtn());
    } else if (type === 'blind-swap' || (type === 'look-swap' && state.power.stage === 0)) {
      const title = type === 'look-swap' ? 'Look & Swap: choose two cards' : 'Blind swap two cards';
      const desc = type === 'look-swap'
        ? "Pick any two cards on the table - you'll see both, then decide whether to swap."
        : 'Pick any two cards on the table to swap, without looking.';
      body.appendChild(el('h3', 'power-title', [document.createTextNode(title)]));
      body.appendChild(el('p', 'power-desc', [document.createTextNode(desc)]));
      const statusLine = el('p', 'hint', [document.createTextNode(
        !power.a ? 'Pick the first card.' : !power.b ? 'Pick the second card.' : 'Ready to confirm.'
      )]);
      body.appendChild(statusLine);
      const isSameTarget = (t, playerId, slot) => t && t.playerId === playerId && t.slot === slot;
      body.appendChild(slotButtonRow(state, () => true, (playerId, slot) => {
        const target = { playerId, slot };
        if (!power.a) { power.a = target; }
        else if (!isSameTarget(power.a, playerId, slot) && !power.b) { power.b = target; }
        renderPowerModal(state);
      }, (playerId, slot) => isSameTarget(power.a, playerId, slot) || isSameTarget(power.b, playerId, slot)));
      if (power.a) {
        const reset = el('button', 'btn btn-ghost', [document.createTextNode('Reset')]);
        reset.onclick = () => { power = { mode: null, a: null, b: null }; renderPowerModal(state); };
        const actions = el('div', 'modal-actions', [reset]);
        if (power.b) {
          const confirm = el('button', 'btn btn-primary', [document.createTextNode('Confirm')]);
          confirm.onclick = () => {
            if (type === 'look-swap') socket.emit('power-look-swap-select', { a: power.a, b: power.b });
            else socket.emit('power-blind-swap', { a: power.a, b: power.b });
            power = { mode: null, a: null, b: null };
          };
          actions.appendChild(confirm);
        }
        body.appendChild(actions);
      }
      if (type === 'blind-swap') body.appendChild(skipBtn());
    } else if (type === 'look-swap' && state.power.stage === 1) {
      // The decide step is rendered by the peek-result modal instead, so this
      // modal would just be a redundant backdrop behind it - keep it closed.
      closeModal('power-modal');
      return;
    }
    openModal('power-modal');
  }

  // ---------- reveal ----------

  function renderReveal(state) {
    $('#reveal-title').textContent = `Round ${state.round} Complete`;
    const wrap = $('#reveal-grids');
    wrap.innerHTML = '';
    state.players.forEach((p) => {
      const row = el('div', 'reveal-player-row');
      const info = el('div', 'reveal-player-info');
      info.appendChild(el('b', '', [document.createTextNode(p.name + (p.id === state.caboCallerId ? ' (Kaabo)' : ''))]));
      info.appendChild(el('span', '', [document.createTextNode(`Round: ${p.roundScore} pts`)]));
      row.appendChild(info);
      const g = el('div', 'reveal-grid');
      p.grid.forEach((c) => g.appendChild(cardEl(c, { size: 'small' })));
      row.appendChild(g);
      wrap.appendChild(row);
    });
    renderScoreList('#reveal-score-list', state);
    const amHost = isHost(state);
    $('#btn-next-round').classList.toggle('hidden', !amHost);
    $('#reveal-waiting-text').classList.toggle('hidden', amHost);
    showScreen('screen-reveal');
  }

  $('#btn-next-round').onclick = () => socket.emit('next-round', {}, (ack) => { if (!ack.ok) toast(ack.error, 'error'); });

  // ---------- game over ----------

  function renderGameOver(state) {
    const winner = [...state.players].sort((a, b) => a.score - b.score)[0];
    $('#winner-name').textContent = winner ? winner.name : '-';
    renderScoreList('#final-score-list', state);
    const amHost = isHost(state);
    $('#btn-new-game').classList.toggle('hidden', !amHost);
    $('#gameover-waiting-text').textContent = amHost ? '' : 'Waiting for the host to start a new game...';
    showScreen('screen-gameover');
  }

  $('#btn-new-game').onclick = () => socket.emit('restart-game', {}, (ack) => { if (!ack.ok) toast(ack.error, 'error'); });

  // ---------- router ----------

  function render(state) {
    const enteringGameOver = state.phase === 'gameover' && lastPhase !== 'gameover';
    if (state.phase !== lastPhase) {
      power = { mode: null, a: null, b: null };
      closeModal('power-modal');
      closeModal('peek-result-modal');
      closePanel('log-panel');
      closePanel('scores-panel');
    }
    lastPhase = state.phase;

    if (state.phase === 'lobby') renderLobby(state);
    else if (state.phase === 'peek') renderPeek(state);
    else if (state.phase === 'playing') renderGame(state);
    else if (state.phase === 'reveal') renderReveal(state);
    else if (state.phase === 'gameover') renderGameOver(state);

    if (enteringGameOver) launchConfetti();
  }
})();
