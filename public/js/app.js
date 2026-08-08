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
    latest = state;
    LS.roomCode = state.code;
    render(state);
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

  function renderPeek(state) {
    $('#peek-round').textContent = state.round;
    const me_ = myPlayer(state);
    const grid = $('#peek-grid');
    grid.innerHTML = '';
    me_.grid.forEach((card) => grid.appendChild(cardEl(card)));
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

    // opponents
    const row = $('#opponents-row');
    row.innerHTML = '';
    state.players.filter((p) => p.id !== state.you).forEach((p) => {
      const isTurn = p.id === state.currentTurn;
      const card = el('div', `opponent-card ${isTurn ? 'active-turn' : ''}`);
      const header = el('div', 'opponent-header');
      const dot = el('span', 'dot');
      dot.style.background = p.color;
      header.appendChild(dot);
      header.appendChild(el('span', 'opponent-name', [document.createTextNode(p.name + (p.connected ? '' : ' (off)'))]));
      if (isTurn) header.appendChild(el('span', 'opponent-turn-badge', [document.createTextNode('Turn')]));
      header.appendChild(el('span', 'opponent-score', [document.createTextNode(String(p.score))]));
      card.appendChild(header);
      const g = el('div', 'opponent-grid');
      p.grid.forEach((c) => g.appendChild(cardEl(c, { size: 'small' })));
      card.appendChild(g);
      row.appendChild(card);
    });

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
  }
})();
