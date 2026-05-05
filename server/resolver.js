'use strict';

const { colorOf, pieceType, pieceValue, rankOf, fileOf, squareAt } = require('./gameState');

function slidingPathClear(gs, from, to) {
  const df = fileOf(to) - fileOf(from);
  const dr = rankOf(to) - rankOf(from);
  const isDiag = Math.abs(df) === Math.abs(dr);
  const isLine = df === 0 || dr === 0;
  if (!isDiag && !isLine) return true; // non-sliding piece, skip
  const sf = Math.sign(df);
  const sr = Math.sign(dr);
  let f = fileOf(from) + sf;
  let r = rankOf(from) + sr;
  while (f !== fileOf(to) || r !== rankOf(to)) {
    if (gs.getPiece(squareAt(f, r))) return false;
    f += sf;
    r += sr;
  }
  return true;
}

/**
 * Resolve a SimulChess move pair.
 *
 * @param {GameState} gs        Current board state (not mutated)
 * @param {{ from, to }} wMove  White's move
 * @param {{ from, to }} bMove  Black's move
 * @returns {{ newState, events, outcome, reason }}
 *   outcome: null | 'white_wins' | 'black_wins' | 'draw'
 */
function resolveMovePair(gs, wMove, bMove) {
  const newGs = gs.clone();
  const events = [];

  const wPiece = gs.getPiece(wMove.from); // e.g. 'P'
  const bPiece = gs.getPiece(bMove.from); // e.g. 'p'

  const wType = pieceType(wPiece);
  const bType = pieceType(bPiece);

  const atWDest = gs.getPiece(wMove.to); // piece at white's destination on start board
  const atBDest = gs.getPiece(bMove.to); // piece at black's destination on start board

  // ---------------------------------------------------------------
  // Pre-resolution validation: diagonal pawn moves require a capture target.
  // A diagonal pawn move is only valid if, at resolution time, there is:
  //   (a) a stationary enemy on the destination (and it didn't escape this turn),
  //   (b) the opponent moves to that same square this turn (same-dest conflict), or
  //   (c) it is an en passant capture.
  // If none hold, the move-pair is invalid → resubmit (counts toward rule 18).
  // ---------------------------------------------------------------
  if (wType === 'p' && fileOf(wMove.to) !== fileOf(wMove.from)) {
    const stationaryEnemy = atWDest && colorOf(atWDest) === 'black' && bMove.from !== wMove.to;
    const opponentArrives = bMove.to === wMove.to;
    const enPassant = wMove.to === gs.enPassant;
    if (!stationaryEnemy && !opponentArrives && !enPassant) {
      return { newState: null, events: [], outcome: null, reason: 'invalid_pawn_diagonal' };
    }
  }
  if (bType === 'p' && fileOf(bMove.to) !== fileOf(bMove.from)) {
    const stationaryEnemy = atBDest && colorOf(atBDest) === 'white' && wMove.from !== bMove.to;
    const opponentArrives = wMove.to === bMove.to;
    const enPassant = bMove.to === gs.enPassant;
    if (!stationaryEnemy && !opponentArrives && !enPassant) {
      return { newState: null, events: [], outcome: null, reason: 'invalid_pawn_diagonal' };
    }
  }

  // ---------------------------------------------------------------
  // Pre-resolution validation: moving to a friendly-occupied square is only
  // valid if the opponent is also moving to that square this turn (i.e. they
  // capture the friendly piece before you land). If the opponent does NOT move
  // there, the move-pair is invalid → resubmit.
  // ---------------------------------------------------------------
  if (atWDest && colorOf(atWDest) === 'white' && bMove.to !== wMove.to) {
    return { newState: null, events: [], outcome: null, reason: 'friendly_occupied' };
  }
  if (atBDest && colorOf(atBDest) === 'black' && wMove.to !== bMove.to) {
    return { newState: null, events: [], outcome: null, reason: 'friendly_occupied' };
  }

  // --- Clear starting squares ---
  newGs.clearSq(wMove.from);
  newGs.clearSq(bMove.from);

  // ---------------------------------------------------------------
  // Post-clear path validation for sliding pieces: enemy pieces in the path
  // were allowed speculatively at submission; now verify they actually moved.
  // After clearing both starting squares, the board reflects pieces-in-transit.
  // ---------------------------------------------------------------
  const wSliding = ['b', 'r', 'q'].includes(wType);
  const bSliding = ['b', 'r', 'q'].includes(bType);
  if (wSliding && !slidingPathClear(newGs, wMove.from, wMove.to)) {
    return { newState: null, events: [], outcome: null, reason: 'path_blocked' };
  }
  if (bSliding && !slidingPathClear(newGs, bMove.from, bMove.to)) {
    return { newState: null, events: [], outcome: null, reason: 'path_blocked' };
  }

  // ---------------------------------------------------------------
  // CASE 1: Both pieces move to the same destination square
  // ---------------------------------------------------------------
  if (wMove.to === bMove.to) {
    const dest = wMove.to;

    // Any stationary piece that was already there is displaced (removed)
    // by the incoming conflict — the winner lands on dest.
    newGs.clearSq(dest);

    const wIsKing = wType === 'k';
    const bIsKing = bType === 'k';

    if (wIsKing && bIsKing) {
      events.push({ type: 'MOVE', color: 'white', from: wMove.from, to: dest });
      events.push({ type: 'MOVE', color: 'black', from: bMove.from, to: dest });
      events.push({ type: 'KING_CAPTURED', color: 'white' });
      events.push({ type: 'KING_CAPTURED', color: 'black' });
      return { newState: newGs, events, outcome: 'draw', reason: 'double_king_capture' };
    }

    if (wIsKing) {
      // White king always wins
      newGs.setPiece(dest, wPiece);
      events.push({ type: 'MOVE', color: 'white', from: wMove.from, to: dest });
      events.push({ type: 'CAPTURE', color: 'white', square: dest }); // black removed
    } else if (bIsKing) {
      // Black king always wins
      newGs.setPiece(dest, bPiece);
      events.push({ type: 'MOVE', color: 'black', from: bMove.from, to: dest });
      events.push({ type: 'CAPTURE', color: 'black', square: dest }); // white removed
    } else {
      // Pawn diagonal move = capture intent; pawn forward move = non-capture.
      // When a capturing pawn meets a forward-moving pawn at the same square,
      // the capturing pawn wins (it was attacking that square).
      const wPawnDiag = wType === 'p' && fileOf(wMove.to) !== fileOf(wMove.from);
      const bPawnDiag = bType === 'p' && fileOf(bMove.to) !== fileOf(bMove.from);

      if (wPawnDiag && bType === 'p' && !bPawnDiag) {
        newGs.setPiece(dest, wPiece);
        events.push({ type: 'MOVE', color: 'white', from: wMove.from, to: dest });
        events.push({ type: 'CAPTURE', color: 'white', square: dest });
      } else if (bPawnDiag && wType === 'p' && !wPawnDiag) {
        newGs.setPiece(dest, bPiece);
        events.push({ type: 'MOVE', color: 'black', from: bMove.from, to: dest });
        events.push({ type: 'CAPTURE', color: 'black', square: dest });
      } else {
        const wVal = pieceValue(wPiece);
        const bVal = pieceValue(bPiece);

        if (wVal > bVal) {
          newGs.setPiece(dest, wPiece);
          events.push({ type: 'MOVE', color: 'white', from: wMove.from, to: dest });
          events.push({ type: 'CAPTURE', color: 'white', square: dest });
        } else if (bVal > wVal) {
          newGs.setPiece(dest, bPiece);
          events.push({ type: 'MOVE', color: 'black', from: bMove.from, to: dest });
          events.push({ type: 'CAPTURE', color: 'black', square: dest });
        } else {
          // Equal value — both removed
          events.push({ type: 'MOVE', color: 'white', from: wMove.from, to: dest });
          events.push({ type: 'MOVE', color: 'black', from: bMove.from, to: dest });
          events.push({ type: 'CAPTURE', color: 'white', square: dest });
          events.push({ type: 'CAPTURE', color: 'black', square: dest });
          // dest already cleared, nothing placed
        }
      }
    }
  } else {
    // ---------------------------------------------------------------
    // CASE 2: Different destinations
    // ---------------------------------------------------------------

    // --- White's move ---
    // White captures if: atWDest is a black piece AND black didn't move FROM that square
    const whiteCaptures = atWDest && colorOf(atWDest) === 'black' && wMove.to !== bMove.from;
    // (if wMove.to === bMove.from, black's piece already left — rule 9)

    events.push({ type: 'MOVE', color: 'white', from: wMove.from, to: wMove.to });
    if (whiteCaptures) {
      events.push({ type: 'CAPTURE', color: 'white', square: wMove.to });
    }
    newGs.setPiece(wMove.to, wPiece);

    // --- Black's move ---
    const blackCaptures = atBDest && colorOf(atBDest) === 'white' && bMove.to !== wMove.from;

    events.push({ type: 'MOVE', color: 'black', from: bMove.from, to: bMove.to });
    if (blackCaptures) {
      events.push({ type: 'CAPTURE', color: 'black', square: bMove.to });
    }
    newGs.setPiece(bMove.to, bPiece);
  }

  // ---------------------------------------------------------------
  // En passant capture — remove the captured pawn (not on dest square)
  // ---------------------------------------------------------------
  if (wType === 'p' && wMove.to === gs.enPassant) {
    const capturedPawnSq = wMove.to[0] + '5'; // en passant target is on rank 6, pawn is on rank 5
    newGs.clearSq(capturedPawnSq);
    events.push({ type: 'CAPTURE', color: 'white', square: capturedPawnSq });
  }
  if (bType === 'p' && bMove.to === gs.enPassant) {
    const capturedPawnSq = bMove.to[0] + '4'; // en passant target is on rank 3, pawn is on rank 4
    newGs.clearSq(capturedPawnSq);
    events.push({ type: 'CAPTURE', color: 'black', square: capturedPawnSq });
  }

  // ---------------------------------------------------------------
  // Pawn promotion (auto-queen)
  // ---------------------------------------------------------------
  const wOnBoard = newGs.getPiece(wMove.to);
  if (wOnBoard === 'P' && wMove.to[1] === '8') {
    newGs.setPiece(wMove.to, 'Q');
    events.push({ type: 'PROMOTE', color: 'white', square: wMove.to, piece: 'Q' });
  }
  const bOnBoard = newGs.getPiece(bMove.to);
  if (bOnBoard === 'p' && bMove.to[1] === '1') {
    newGs.setPiece(bMove.to, 'q');
    events.push({ type: 'PROMOTE', color: 'black', square: bMove.to, piece: 'q' });
  }

  // ---------------------------------------------------------------
  // Castling — move the rook when king castles
  // ---------------------------------------------------------------
  if (wType === 'k' && wMove.from === 'e1') {
    if (wMove.to === 'g1') { // kingside
      newGs.clearSq('h1');
      newGs.setPiece('f1', 'R');
      newGs.castling.K = false;
      newGs.castling.Q = false;
      events.push({ type: 'CASTLE', color: 'white', side: 'kingside' });
    } else if (wMove.to === 'c1') { // queenside
      newGs.clearSq('a1');
      newGs.setPiece('d1', 'R');
      newGs.castling.K = false;
      newGs.castling.Q = false;
      events.push({ type: 'CASTLE', color: 'white', side: 'queenside' });
    }
  }
  if (bType === 'k' && bMove.from === 'e8') {
    if (bMove.to === 'g8') {
      newGs.clearSq('h8');
      newGs.setPiece('f8', 'r');
      newGs.castling.k = false;
      newGs.castling.q = false;
      events.push({ type: 'CASTLE', color: 'black', side: 'kingside' });
    } else if (bMove.to === 'c8') {
      newGs.clearSq('a8');
      newGs.setPiece('d8', 'r');
      newGs.castling.k = false;
      newGs.castling.q = false;
      events.push({ type: 'CASTLE', color: 'black', side: 'queenside' });
    }
  }

  // ---------------------------------------------------------------
  // Update castling rights when rooks move or are captured
  // ---------------------------------------------------------------
  if (wMove.from === 'h1' || !newGs.getPiece('h1')) newGs.castling.K = false;
  if (wMove.from === 'a1' || !newGs.getPiece('a1')) newGs.castling.Q = false;
  if (bMove.from === 'h8' || !newGs.getPiece('h8')) newGs.castling.k = false;
  if (bMove.from === 'a8' || !newGs.getPiece('a8')) newGs.castling.q = false;

  // ---------------------------------------------------------------
  // Update en passant target for next turn
  // ---------------------------------------------------------------
  newGs.enPassant = null;
  if (wType === 'p' && Math.abs(rankOf(wMove.to) - rankOf(wMove.from)) === 2) {
    newGs.enPassant = wMove.to[0] + '3'; // passed through rank 3
  }
  if (bType === 'p' && Math.abs(rankOf(bMove.to) - rankOf(bMove.from)) === 2) {
    newGs.enPassant = bMove.to[0] + '6'; // passed through rank 6
  }

  // ---------------------------------------------------------------
  // Update clocks
  // ---------------------------------------------------------------
  const isPawnMove = wType === 'p' || bType === 'p';
  const isCapture = events.some(e => e.type === 'CAPTURE');
  newGs.halfmove = (isPawnMove || isCapture) ? 0 : gs.halfmove + 1;
  newGs.fullmove = gs.fullmove + 1;
  newGs.activeColor = 'w';

  // ---------------------------------------------------------------
  // Check for king capture → determine outcome
  // ---------------------------------------------------------------
  const wKingAlive = !!newGs.findKing('white');
  const bKingAlive = !!newGs.findKing('black');

  if (!wKingAlive && !bKingAlive) {
    return { newState: newGs, events, outcome: 'draw', reason: 'double_king_capture' };
  }
  if (!wKingAlive) {
    events.push({ type: 'KING_CAPTURED', color: 'white' });
    return { newState: newGs, events, outcome: 'black_wins', reason: 'king_capture' };
  }
  if (!bKingAlive) {
    events.push({ type: 'KING_CAPTURED', color: 'black' });
    return { newState: newGs, events, outcome: 'white_wins', reason: 'king_capture' };
  }

  return { newState: newGs, events, outcome: null, reason: null };
}

module.exports = { resolveMovePair };
