'use strict';

const { fileOf, rankOf, squareAt, colorOf, pieceType } = require('./gameState');

function squaresOnRay(fromSq, dFile, dRank) {
  const squares = [];
  let f = fileOf(fromSq) + dFile;
  let r = rankOf(fromSq) + dRank;
  while (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
    squares.push(squareAt(f, r));
    f += dFile;
    r += dRank;
  }
  return squares;
}

function pathClear(gameState, fromSq, toSq, dFile, dRank, movingColor) {
  const ray = squaresOnRay(fromSq, dFile, dRank);
  for (const sq of ray) {
    if (sq === toSq) return true;
    const p = gameState.getPiece(sq);
    if (p && colorOf(p) === movingColor) return false; // own piece blocks path
    // enemy piece in path is allowed speculatively — it may move away this turn
  }
  return false;
}

function isValidMove(gameState, from, to, color) {
  if (!from || !to || from === to) return false;

  const piece = gameState.getPiece(from);
  if (!piece) return false;
  if (colorOf(piece) !== color) return false;

  const dest = gameState.getPiece(to);

  const type = pieceType(piece);
  const isWhiteColor = color === 'white';

  const fFrom = fileOf(from);
  const rFrom = rankOf(from);
  const fTo = fileOf(to);
  const rTo = rankOf(to);
  const df = fTo - fFrom;
  const dr = rTo - rFrom;

  switch (type) {
    case 'p': return validatePawn(gameState, from, to, isWhiteColor, fFrom, rFrom, fTo, rTo, df, dr);
    case 'n': return validateKnight(df, dr);
    case 'b': return validateBishop(gameState, from, to, color, df, dr);
    case 'r': return validateRook(gameState, from, to, color, df, dr);
    case 'q': return validateQueen(gameState, from, to, color, df, dr);
    case 'k': return validateKing(gameState, from, to, color, df, dr);
    default: return false;
  }
}

function validatePawn(gs, from, to, isWhite, fFrom, rFrom, fTo, rTo, df, dr) {
  const forward = isWhite ? 1 : -1;
  const homeRank = isWhite ? 1 : 6;

  // One square forward
  if (df === 0 && dr === forward) {
    return !gs.getPiece(to);
  }

  // Two squares forward from home rank
  if (df === 0 && dr === 2 * forward && rFrom === homeRank) {
    const middle = squareAt(fFrom, rFrom + forward);
    return !gs.getPiece(middle) && !gs.getPiece(to);
  }

  // Diagonal capture (including en passant, and empty squares in SimulChess).
  // Allow diagonal moves to empty squares: the opponent may simultaneously move a
  // piece there, making it a valid capture at resolution time.
  if (Math.abs(df) === 1 && dr === forward) {
    const destPiece = gs.getPiece(to);
    if (!destPiece) return true;                                         // empty — speculative capture
    if (colorOf(destPiece) !== (isWhite ? 'white' : 'black')) return true; // enemy piece
    if (to === gs.enPassant) return true;                                // en passant
    // own piece at dest is already blocked by the early same-color check above
  }

  return false;
}

function validateKnight(df, dr) {
  return (Math.abs(df) === 2 && Math.abs(dr) === 1) ||
         (Math.abs(df) === 1 && Math.abs(dr) === 2);
}

function validateBishop(gs, from, to, color, df, dr) {
  if (Math.abs(df) !== Math.abs(dr) || df === 0) return false;
  return pathClear(gs, from, to, Math.sign(df), Math.sign(dr), color);
}

function validateRook(gs, from, to, color, df, dr) {
  if (df !== 0 && dr !== 0) return false;
  if (df === 0 && dr === 0) return false;
  return pathClear(gs, from, to, Math.sign(df), Math.sign(dr), color);
}

function validateQueen(gs, from, to, color, df, dr) {
  return validateBishop(gs, from, to, color, df, dr) || validateRook(gs, from, to, color, df, dr);
}

function validateKing(gs, from, to, color, df, dr) {
  // Normal one-square move
  if (Math.abs(df) <= 1 && Math.abs(dr) <= 1 && (df !== 0 || dr !== 0)) return true;

  // Castling: king moves exactly 2 squares horizontally
  if (Math.abs(df) === 2 && dr === 0) {
    const isWhite = color === 'white';
    const rank = isWhite ? '1' : '8';

    if (from !== 'e' + rank) return false;

    if (df === 2) { // kingside
      const right = isWhite ? gs.castling.K : gs.castling.k;
      if (!right) return false;
      return !gs.getPiece('f' + rank) && !gs.getPiece('g' + rank);
    } else { // queenside df === -2
      const right = isWhite ? gs.castling.Q : gs.castling.q;
      if (!right) return false;
      return !gs.getPiece('d' + rank) && !gs.getPiece('c' + rank) && !gs.getPiece('b' + rank);
    }
  }

  return false;
}

module.exports = { isValidMove };
