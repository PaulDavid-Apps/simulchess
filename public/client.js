/**
 * SimulChess client — ES module
 *
 * State machine: IDLE → QUEUING | WAITING | JOINING → PLAYING → SUBMITTED → ANIMATING → FINISHED
 */

// ── State ────────────────────────────────────────────────────────────────────

let ws = null;
let state = 'IDLE'; // current machine state
let myColor = null;      // 'white' | 'black'
let currentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
let selectedMove = null; // { from, to } pending confirmation
let timerInterval = null;
let timerMs = 60_000;
let turnStartTime = null;
// Wait for the chess-board custom element to be defined before using its API
await customElements.whenDefined('chess-board');

// ── DOM refs ─────────────────────────────────────────────────────────────────

const screens = {
  home:     document.getElementById('screen-home'),
  join:     document.getElementById('screen-join'),
  lobby:    document.getElementById('screen-lobby'),
  game:     document.getElementById('screen-game'),
  gameover: document.getElementById('screen-gameover'),
};

const board = document.getElementById('board');

const el = {
  // home
  btnPlay:      document.getElementById('btn-play'),
  btnInvite:    document.getElementById('btn-invite'),
  btnShowJoin:  document.getElementById('btn-show-join'),
  homeError:    document.getElementById('home-error'),

  // join
  joinInput:    document.getElementById('join-code-input'),
  btnJoin:      document.getElementById('btn-join'),
  joinError:    document.getElementById('join-error'),
  btnJoinBack:  document.getElementById('btn-join-back'),

  // lobby
  lobbyTitle:     document.getElementById('lobby-title'),
  lobbySub:       document.getElementById('lobby-subtitle'),
  inviteCodeBox:  document.getElementById('invite-code-box'),
  inviteCodeDisp: document.getElementById('invite-code-display'),
  copyConfirm:    document.getElementById('copy-confirm'),
  btnCancelLobby: document.getElementById('btn-cancel-lobby'),

  // game
  timerMineVal:      document.getElementById('timer-mine-value'),
  timerMineLabel:    document.getElementById('timer-mine-label'),
  timerOppVal:       document.getElementById('timer-opponent-value'),
  timerOppLabel:     document.getElementById('timer-opponent-label'),
  statusBar:         document.getElementById('status-bar'),
  statusText:        document.getElementById('status-text'),
  selectedMoveDisp:  document.getElementById('selected-move-display'),
  btnConfirm:        document.getElementById('btn-confirm'),
  btnClear:          document.getElementById('btn-clear'),
  lastResult:        document.getElementById('last-result'),
  btnResign:         document.getElementById('btn-resign'),

  // gameover
  resultBadge:   document.getElementById('result-badge'),
  resultHeading: document.getElementById('result-heading'),
  resultReason:  document.getElementById('result-reason'),
  btnPlayAgain:  document.getElementById('btn-play-again'),
  btnHome:       document.getElementById('btn-home'),
};

// ── Screen switching ─────────────────────────────────────────────────────────

function showScreen(name) {
  for (const [k, div] of Object.entries(screens)) {
    div.classList.toggle('active', k === name);
  }
}

// ── WebSocket connection ──────────────────────────────────────────────────────

function connect(onReady) {
  if (ws && ws.readyState === WebSocket.OPEN) { onReady(); return; }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener('open', onReady);
  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleServerMessage(msg);
  });
  ws.addEventListener('close', handleWsClose);
  ws.addEventListener('error', handleWsClose);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function handleWsClose() {
  if (state === 'IDLE') return;
  if (state === 'FINISHED') return;
  showGameOver('—', 'Connection lost', 'disconnected');
}

// ── Server message handler ───────────────────────────────────────────────────

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'QUEUED':
      // Already shown lobby screen
      break;

    case 'ROOM_CREATED':
      state = 'WAITING';
      el.lobbyTitle.textContent = 'Waiting for opponent…';
      el.lobbySub.textContent = 'Share the code below';
      el.inviteCodeBox.style.display = '';
      el.inviteCodeDisp.textContent = msg.code;
      break;

    case 'JOIN_ERROR':
      state = 'IDLE';
      showScreen('join');
      el.joinError.textContent =
        msg.reason === 'not_found' ? 'Code not found. Check and try again.' :
        msg.reason === 'room_full' ? 'That game is already full.' :
        'Could not join. Try again.';
      break;

    case 'GAME_START':
      startGame(msg);
      break;

    case 'MOVE_ACCEPTED':
      state = 'SUBMITTED';
      setStatus('submitted', 'Move submitted — waiting for opponent…');
      el.btnConfirm.disabled = true;
      el.btnClear.disabled = true;
      break;

    case 'MOVE_REJECTED':
      setStatus('waiting', 'Move rejected — please try again.');
      selectedMove = null;
      updateMoveDisplay();
      loadFen(currentFen);
      break;

    case 'OPPONENT_SUBMITTED':
      if (state === 'SUBMITTED') {
        setStatus('both', 'Opponent submitted — resolving…');
      } else {
        setStatus('waiting', 'Opponent submitted — submit your move!');
      }
      break;

    case 'TURN_RESULT':
      handleTurnResult(msg);
      break;

    case 'RESUBMIT':
      state = 'PLAYING';
      setStatus('waiting', `Unresolvable conflict (attempt ${msg.attempt}/3) — resubmit moves`);
      loadFen(msg.fen);
      selectedMove = null;
      updateMoveDisplay();
      enableMoveInput(true);
      startCountdown(Date.now(), timerMs);
      break;

    case 'GAME_OVER':
      handleGameOver(msg);
      break;

    case 'OPPONENT_DISCONNECTED':
      handleGameOver({ outcome: myColor === 'white' ? 'white_wins' : 'black_wins', reason: 'disconnect' });
      break;
  }
}

// ── Game start ────────────────────────────────────────────────────────────────

function startGame(msg) {
  state = 'PLAYING';
  myColor = msg.color;
  timerMs = msg.timerMs ?? 60_000;

  loadFen(msg.fen);
  board.orientation = myColor === 'black' ? 'black' : 'white';

  el.timerMineLabel.textContent = myColor === 'white' ? 'You (White)' : 'You (Black)';
  el.timerOppLabel.textContent  = myColor === 'white' ? 'Opponent (Black)' : 'Opponent (White)';

  selectedMove = null;
  updateMoveDisplay();
  enableMoveInput(true);
  setStatus('waiting', 'Your turn — drag a piece to select your move');

  el.lastResult.innerHTML = '<div class="events-line">Game started. Good luck!</div>';

  showScreen('game');
  startCountdown(msg.startTime ?? Date.now(), timerMs);
}

// ── Turn result ───────────────────────────────────────────────────────────────

async function handleTurnResult(msg) {
  state = 'ANIMATING';
  stopTimer();
  enableMoveInput(false);

  // Show both moves
  const wAlg = moveToAlg(msg.moves.white);
  const bAlg = moveToAlg(msg.moves.black);
  const evtLines = msg.events
    .filter(e => e.type !== 'MOVE')
    .map(describeEvent)
    .filter(Boolean);

  el.lastResult.innerHTML =
    `<div class="moves-line">White: ${wAlg} &nbsp;|&nbsp; Black: ${bAlg}</div>` +
    (evtLines.length ? `<div class="events-line">${evtLines.join(' · ')}</div>` : '');

  setStatus('', 'Resolving…');

  // Animation: 3 steps that match SimulChess's simultaneous nature.
  // Sequential event-by-event animation is wrong here: both moves happen at
  // the same time, so applying them one after the other causes pieces that
  // share squares (e.g. rook moves TO the square the king moves FROM) to
  // read stale positions and jump around.

  // Step 1 — reset any staged drag to the true pre-move position.
  loadFen(currentFen);
  await sleep(350);

  // Step 2 — lift both pieces simultaneously from their starting squares.
  try {
    const pos = board.position ? { ...board.position } : {};
    delete pos[msg.moves.white.from];
    delete pos[msg.moves.black.from];
    board.setPosition(pos, false);
  } catch (_) {}
  await sleep(350);

  // Step 3 — land on the authoritative resolved position.
  loadFen(msg.fen);

  if (msg.outcome) {
    handleGameOver({ outcome: msg.outcome, reason: msg.reason });
    return;
  }

  // Guard against a GAME_OVER arriving while we were animating
  if (state === 'FINISHED') return;

  // Next turn
  state = 'PLAYING';
  selectedMove = null;
  updateMoveDisplay();
  enableMoveInput(true);
  setStatus('waiting', 'Your turn — drag a piece to select your move');
  startCountdown(msg.startTime ?? Date.now(), msg.timerMs ?? timerMs);
}


// ── Game over ─────────────────────────────────────────────────────────────────

function handleGameOver(msg) {
  if (state === 'FINISHED') return;
  state = 'FINISHED';
  stopTimer();

  showGameOver(msg.outcome, msg.reason);
}

function showGameOver(outcome, reason) {
  const iWin   = (myColor === 'white' && outcome === 'white_wins') ||
                 (myColor === 'black' && outcome === 'black_wins');
  const isLoss = (myColor === 'white' && outcome === 'black_wins') ||
                 (myColor === 'black' && outcome === 'white_wins');
  const isDraw = outcome === 'draw';

  el.resultBadge.textContent   = isDraw ? '🤝' : iWin ? '🏆' : '😔';
  el.resultHeading.textContent = isDraw ? 'Draw!' : iWin ? 'You Win!' : 'You Lose';
  el.resultReason.textContent  = reasonText(reason);

  showScreen('gameover');
}

function reasonText(reason) {
  switch (reason) {
    case 'king_capture':   return 'A king was captured';
    case 'double_king_capture': return 'Both kings were captured simultaneously';
    case 'timeout':        return 'Time ran out';
    case 'resign':         return 'Player resigned';
    case 'resubmit_limit': return 'Three unresolvable turns — drawn';
    case 'disconnect':     return 'Opponent disconnected';
    default: return '';
  }
}

// ── Board integration ─────────────────────────────────────────────────────────

function loadFen(fen) {
  currentFen = fen;
  board.setPosition(fenToPosition(fen), false);
}

function fenToPosition(fen) {
  // Parse the piece-placement part of the FEN into chessboard-element's position object
  // chessboard-element uses { e2: 'wP', e4: 'wQ', ... }
  const pieceMap = { p:'P', n:'N', b:'B', r:'R', q:'Q', k:'K' };
  const colorMap = { P:'w', N:'w', B:'w', R:'w', Q:'w', K:'w',
                     p:'b', n:'b', b:'b', r:'b', q:'b', k:'b' };
  const pos = {};
  const rows = fen.split(' ')[0].split('/');
  const files = 'abcdefgh';

  for (let ri = 0; ri < 8; ri++) {
    const rank = 8 - ri;
    let fi = 0;
    for (const ch of rows[ri]) {
      if (/\d/.test(ch)) { fi += parseInt(ch); }
      else {
        const sq = files[fi] + rank;
        pos[sq] = colorMap[ch] + pieceMap[ch.toLowerCase()];
        fi++;
      }
    }
  }
  return pos;
}

// ── Move selection via chessboard-element drag ────────────────────────────────

// chessboard-element fires 'drag-start' and 'drop' custom events
board.addEventListener('drag-start', (e) => {
  if (state !== 'PLAYING') {
    e.preventDefault(); // cancel drag
    return;
  }

  const { piece, source } = e.detail;
  if (!piece) { e.preventDefault(); return; }

  const isMyPiece = (myColor === 'white' && piece[0] === 'w') ||
                    (myColor === 'black' && piece[0] === 'b');
  if (!isMyPiece) { e.preventDefault(); return; }
});

board.addEventListener('drop', (e) => {
  if (state !== 'PLAYING') {
    e.detail.setAction('snapback');
    return;
  }

  const { source, target, piece } = e.detail;

  if (target === 'offboard' || source === target) {
    e.detail.setAction('snapback');
    return;
  }

  // Validate that this is our piece and a plausible move
  const isMyPiece = (myColor === 'white' && piece[0] === 'w') ||
                    (myColor === 'black' && piece[0] === 'b');
  if (!isMyPiece) { e.detail.setAction('snapback'); return; }

  // Accept the drop visually and stage the move
  selectedMove = { from: source, to: target };
  updateMoveDisplay();
  el.btnConfirm.disabled = false;
  el.btnClear.disabled = false;
});

// Keep board position after drop (don't snap back — we stage the move)
board.addEventListener('snap-end', () => {
  // Intentionally empty — position already updated by drag
});

// ── Move input controls ───────────────────────────────────────────────────────

function enableMoveInput(enabled) {
  board.draggablePieces = enabled;
  if (!enabled) {
    el.btnConfirm.disabled = true;
    el.btnClear.disabled = true;
  }
}

function updateMoveDisplay() {
  if (selectedMove) {
    el.selectedMoveDisp.textContent = `${selectedMove.from.toUpperCase()} → ${selectedMove.to.toUpperCase()}`;
    el.selectedMoveDisp.classList.add('has-move');
  } else {
    el.selectedMoveDisp.textContent = 'No move selected';
    el.selectedMoveDisp.classList.remove('has-move');
  }
}

el.btnConfirm.addEventListener('click', () => {
  if (!selectedMove || state !== 'PLAYING') return;
  send({ type: 'SUBMIT_MOVE', from: selectedMove.from, to: selectedMove.to });
});

el.btnClear.addEventListener('click', () => {
  if (state !== 'PLAYING') return;
  selectedMove = null;
  updateMoveDisplay();
  el.btnConfirm.disabled = true;
  el.btnClear.disabled = false;
  // Reload board to undo any staged visual
  loadFen(currentFen);
});

// ── Status bar ────────────────────────────────────────────────────────────────

function setStatus(cls, text) {
  el.statusBar.className = 'status-bar ' + (cls || '');
  el.statusText.textContent = text;
}

// ── Timer ─────────────────────────────────────────────────────────────────────

function startCountdown(startTime, durationMs) {
  stopTimer();
  turnStartTime = startTime;
  timerMs = durationMs;

  timerInterval = setInterval(() => {
    const elapsed = Date.now() - turnStartTime;
    const remaining = Math.max(0, durationMs - elapsed);
    renderTimers(remaining);
    if (remaining === 0) stopTimer();
  }, 200);

  renderTimers(durationMs);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function renderTimers(remaining) {
  const secs = Math.ceil(remaining / 1000);
  const formatted = formatTime(remaining);

  el.timerMineVal.textContent = formatted;
  el.timerOppVal.textContent  = formatted; // both count same turn timer

  const cls = secs <= 10 ? 'urgent' : secs <= 20 ? 'warning' : '';
  el.timerMineVal.className = 'timer-value ' + cls;
}

function formatTime(ms) {
  const totalSecs = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Button event listeners ────────────────────────────────────────────────────

el.btnPlay.addEventListener('click', () => {
  el.homeError.textContent = '';
  connect(() => {
    state = 'QUEUING';
    el.lobbyTitle.textContent = 'Finding opponent…';
    el.lobbySub.textContent   = 'You\'ll be matched automatically';
    el.inviteCodeBox.style.display = 'none';
    showScreen('lobby');
    send({ type: 'JOIN_QUEUE' });
  });
});

el.btnInvite.addEventListener('click', () => {
  el.homeError.textContent = '';
  connect(() => {
    state = 'WAITING';
    el.lobbyTitle.textContent = 'Creating invite…';
    el.lobbySub.textContent   = 'Share the code with your opponent';
    el.inviteCodeBox.style.display = 'none';
    showScreen('lobby');
    send({ type: 'CREATE_INVITE' });
  });
});

el.btnShowJoin.addEventListener('click', () => {
  el.joinError.textContent = '';
  el.joinInput.value = '';
  showScreen('join');
});

el.btnJoinBack.addEventListener('click', () => showScreen('home'));

el.btnJoin.addEventListener('click', doJoin);
el.joinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  const code = el.joinInput.value.trim().toUpperCase();
  if (code.length < 2) { el.joinError.textContent = 'Please enter a code.'; return; }
  el.joinError.textContent = '';
  connect(() => {
    state = 'JOINING';
    send({ type: 'JOIN_INVITE', code });
  });
}

el.btnCancelLobby.addEventListener('click', () => {
  if (ws) { ws.close(); ws = null; }
  state = 'IDLE';
  showScreen('home');
});

el.btnResign.addEventListener('click', () => {
  if (state !== 'PLAYING' && state !== 'SUBMITTED') return;
  if (!confirm('Are you sure you want to resign?')) return;
  send({ type: 'RESIGN' });
});

el.btnPlayAgain.addEventListener('click', () => {
  if (ws) { ws.close(); ws = null; }
  state = 'IDLE';
  selectedMove = null;
  showScreen('home');
});

el.btnHome.addEventListener('click', () => {
  if (ws) { ws.close(); ws = null; }
  state = 'IDLE';
  selectedMove = null;
  showScreen('home');
});

el.inviteCodeDisp.addEventListener('click', () => {
  const code = el.inviteCodeDisp.textContent;
  navigator.clipboard.writeText(code).then(() => {
    el.copyConfirm.textContent = 'Copied!';
    setTimeout(() => { el.copyConfirm.textContent = ''; }, 2000);
  }).catch(() => {
    el.copyConfirm.textContent = 'Press Ctrl+C to copy';
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function moveToAlg(move) {
  if (!move) return '—';
  return move.from.toUpperCase() + '–' + move.to.toUpperCase();
}

function describeEvent(evt) {
  switch (evt.type) {
    case 'CAPTURE':      return `${capitalize(evt.color)} captured on ${evt.square.toUpperCase()}`;
    case 'PROMOTE':      return `${capitalize(evt.color)} promoted to Queen`;
    case 'CASTLE':       return `${capitalize(evt.color)} castled ${evt.side}`;
    case 'KING_CAPTURED': return `${capitalize(evt.color)} king captured!`;
    default: return null;
  }
}

function capitalize(s) { return s[0].toUpperCase() + s.slice(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
