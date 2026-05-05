'use strict';

const { v4: uuidv4 } = require('uuid');
const { GameState, STARTING_FEN } = require('./gameState');
const { isValidMove } = require('./moveValidator');
const { resolveMovePair } = require('./resolver');

const TIMER_MS = 60_000;

// In-memory state
let waitingPlayer = null; // { ws }
const rooms = new Map();       // roomId → Room
const invites = new Map();     // code → roomId
const socketToRoom = new Map(); // ws → roomId
const socketToColor = new Map(); // ws → 'white'|'black'

function send(ws, obj) {
  if (ws && ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(obj));
  }
}

function sendBoth(room, obj) {
  send(room.players.white, obj);
  send(room.players.black, obj);
}

// ---------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------

function handleConnection(ws) {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
}

function handleDisconnect(ws) {
  // Remove from waiting queue
  if (waitingPlayer && waitingPlayer.ws === ws) {
    waitingPlayer = null;
    return;
  }

  const roomId = socketToRoom.get(ws);
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  socketToRoom.delete(ws);
  socketToColor.delete(ws);

  if (room.status === 'active') {
    const color = room.players.white === ws ? 'white' : 'black';
    const opponentColor = color === 'white' ? 'black' : 'white';
    const opponentWs = room.players[opponentColor];

    send(opponentWs, { type: 'OPPONENT_DISCONNECTED' });
    endGame(room, `${opponentColor}_wins`, 'disconnect');
  } else {
    // Waiting for second player in invite room
    clearRoom(room);
  }
}

// ---------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'JOIN_QUEUE':    return handleJoinQueue(ws);
    case 'CREATE_INVITE': return handleCreateInvite(ws);
    case 'JOIN_INVITE':   return handleJoinInvite(ws, msg.code);
    case 'SUBMIT_MOVE':   return handleSubmitMove(ws, msg.from, msg.to);
    case 'RESIGN':        return handleResign(ws);
  }
}

// ---------------------------------------------------------------
// Matchmaking
// ---------------------------------------------------------------

function handleJoinQueue(ws) {
  // Already in a room?
  if (socketToRoom.has(ws)) return;

  if (waitingPlayer && waitingPlayer.ws.readyState === 1) {
    const opponent = waitingPlayer;
    waitingPlayer = null;
    startGame(opponent.ws, ws);
  } else {
    waitingPlayer = { ws };
    send(ws, { type: 'QUEUED' });
  }
}

function handleCreateInvite(ws) {
  if (socketToRoom.has(ws)) return;

  const code = generateCode();
  const roomId = uuidv4();
  const room = createRoom(roomId, code);

  room.players.white = ws;
  rooms.set(roomId, room);
  invites.set(code, roomId);
  socketToRoom.set(ws, roomId);
  socketToColor.set(ws, 'white');

  send(ws, { type: 'ROOM_CREATED', code });
}

function handleJoinInvite(ws, code) {
  if (!code) return send(ws, { type: 'JOIN_ERROR', reason: 'not_found' });
  if (socketToRoom.has(ws)) return;

  const roomId = invites.get(code.toUpperCase());
  if (!roomId) return send(ws, { type: 'JOIN_ERROR', reason: 'not_found' });

  const room = rooms.get(roomId);
  if (!room) return send(ws, { type: 'JOIN_ERROR', reason: 'not_found' });
  if (room.players.black !== null) return send(ws, { type: 'JOIN_ERROR', reason: 'room_full' });
  if (room.status !== 'waiting') return send(ws, { type: 'JOIN_ERROR', reason: 'room_full' });

  room.players.black = ws;
  socketToRoom.set(ws, roomId);
  socketToColor.set(ws, 'black');

  startGame(room.players.white, ws, room);
}

// ---------------------------------------------------------------
// Game lifecycle
// ---------------------------------------------------------------

function createRoom(roomId, inviteCode = null) {
  return {
    id: roomId,
    inviteCode,
    players: { white: null, black: null },
    state: GameState.fromFEN(STARTING_FEN),
    pending: { white: null, black: null },
    timer: null,
    startTime: null,
    timerMs: TIMER_MS,
    resubmitCount: 0,
    status: 'waiting',
  };
}

function startGame(whiteWs, blackWs, existingRoom = null) {
  let room = existingRoom;

  if (!room) {
    const roomId = uuidv4();
    room = createRoom(roomId);
    room.players.white = whiteWs;
    room.players.black = blackWs;
    rooms.set(roomId, room);
    socketToRoom.set(whiteWs, roomId);
    socketToRoom.set(blackWs, roomId);
    socketToColor.set(whiteWs, 'white');
    socketToColor.set(blackWs, 'black');
  }

  room.status = 'active';

  const fen = room.state.toFEN();
  send(whiteWs, { type: 'GAME_START', color: 'white', fen, timerMs: room.timerMs });
  send(blackWs, { type: 'GAME_START', color: 'black', fen, timerMs: room.timerMs });

  startTurnTimer(room);
}

function startTurnTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.startTime = Date.now();

  room.timer = setTimeout(() => {
    const { white, black } = room.pending;
    if (!white && !black) {
      endGame(room, 'draw', 'timeout');
    } else if (!white) {
      endGame(room, 'black_wins', 'timeout');
    } else {
      endGame(room, 'white_wins', 'timeout');
    }
  }, room.timerMs);
}

function handleSubmitMove(ws, from, to) {
  const roomId = socketToRoom.get(ws);
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room || room.status !== 'active') return;

  const color = socketToColor.get(ws);
  if (!color) return;

  // Already submitted this turn
  if (room.pending[color]) {
    send(ws, { type: 'MOVE_REJECTED', reason: 'already_submitted' });
    return;
  }

  if (!isValidMove(room.state, from, to, color)) {
    send(ws, { type: 'MOVE_REJECTED', reason: 'invalid_move' });
    return;
  }

  room.pending[color] = { from, to };
  send(ws, { type: 'MOVE_ACCEPTED' });

  const opponentColor = color === 'white' ? 'black' : 'white';
  send(room.players[opponentColor], { type: 'OPPONENT_SUBMITTED' });

  if (room.pending.white && room.pending.black) {
    clearTimeout(room.timer);
    room.timer = null;
    resolveTurn(room);
  }
}

function resolveTurn(room) {
  const result = resolveMovePair(room.state, room.pending.white, room.pending.black);

  const resolvedMoves = { white: room.pending.white, black: room.pending.black };
  room.pending = { white: null, black: null };

  if (!result.newState) {
    // Unresolvable (shouldn't happen with current algorithm, but handle defensively)
    room.resubmitCount++;
    if (room.resubmitCount >= 3) {
      endGame(room, 'draw', 'resubmit_limit');
      return;
    }
    sendBoth(room, {
      type: 'RESUBMIT',
      attempt: room.resubmitCount,
      fen: room.state.toFEN(),
    });
    startTurnTimer(room);
    return;
  }

  room.resubmitCount = 0;
  room.state = result.newState;

  const fen = room.state.toFEN();
  const startTime = Date.now();

  sendBoth(room, {
    type: 'TURN_RESULT',
    fen,
    moves: resolvedMoves,
    events: result.events,
    timerMs: room.timerMs,
    startTime,
  });

  if (result.outcome) {
    endGame(room, result.outcome, result.reason);
    return;
  }

  startTurnTimer(room);
}

function endGame(room, outcome, reason) {
  if (room.status === 'finished') return;
  room.status = 'finished';

  if (room.timer) { clearTimeout(room.timer); room.timer = null; }

  sendBoth(room, { type: 'GAME_OVER', outcome, reason });

  // Clean up after a delay
  setTimeout(() => clearRoom(room), 5 * 60 * 1000);
}

function clearRoom(room) {
  if (room.inviteCode) invites.delete(room.inviteCode);
  if (room.players.white) {
    socketToRoom.delete(room.players.white);
    socketToColor.delete(room.players.white);
  }
  if (room.players.black) {
    socketToRoom.delete(room.players.black);
    socketToColor.delete(room.players.black);
  }
  rooms.delete(room.id);
}

function handleResign(ws) {
  const roomId = socketToRoom.get(ws);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room || room.status !== 'active') return;

  const color = socketToColor.get(ws);
  const opponentColor = color === 'white' ? 'black' : 'white';
  endGame(room, `${opponentColor}_wins`, 'resign');
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (invites.has(code));
  return code;
}

module.exports = { handleConnection };
