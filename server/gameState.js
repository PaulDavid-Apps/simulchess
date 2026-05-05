'use strict';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const FILES = 'abcdefgh';
const RANKS = '12345678';

function fileOf(sq) { return FILES.indexOf(sq[0]); }
function rankOf(sq) { return parseInt(sq[1]) - 1; }
function squareAt(file, rank) {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return FILES[file] + RANKS[rank];
}

function isWhite(code) { return code === code.toUpperCase(); }
function colorOf(code) { return isWhite(code) ? 'white' : 'black'; }
function pieceType(code) { return code.toLowerCase(); }

class GameState {
  constructor() {
    this.squares = new Map(); // sq -> piece code (e.g. 'P', 'k')
    this.castling = { K: false, Q: false, k: false, q: false };
    this.enPassant = null; // target square string or null
    this.halfmove = 0;
    this.fullmove = 1;
    this.activeColor = 'w';
  }

  static fromFEN(fen = STARTING_FEN) {
    const gs = new GameState();
    const parts = fen.trim().split(' ');
    const rows = parts[0].split('/');

    for (let rankIdx = 0; rankIdx < 8; rankIdx++) {
      const rank = 7 - rankIdx; // FEN rank 8 is index 0
      let file = 0;
      for (const ch of rows[rankIdx]) {
        if (/\d/.test(ch)) {
          file += parseInt(ch);
        } else {
          gs.squares.set(FILES[file] + RANKS[rank], ch);
          file++;
        }
      }
    }

    gs.activeColor = parts[1] || 'w';

    const castleStr = parts[2] || '-';
    gs.castling.K = castleStr.includes('K');
    gs.castling.Q = castleStr.includes('Q');
    gs.castling.k = castleStr.includes('k');
    gs.castling.q = castleStr.includes('q');

    gs.enPassant = (parts[3] && parts[3] !== '-') ? parts[3] : null;
    gs.halfmove = parseInt(parts[4]) || 0;
    gs.fullmove = parseInt(parts[5]) || 1;

    return gs;
  }

  toFEN() {
    let placement = '';
    for (let rankIdx = 7; rankIdx >= 0; rankIdx--) {
      let empty = 0;
      for (let fileIdx = 0; fileIdx < 8; fileIdx++) {
        const sq = FILES[fileIdx] + RANKS[rankIdx];
        const piece = this.squares.get(sq);
        if (piece) {
          if (empty > 0) { placement += empty; empty = 0; }
          placement += piece;
        } else {
          empty++;
        }
      }
      if (empty > 0) placement += empty;
      if (rankIdx > 0) placement += '/';
    }

    const castleStr = [
      this.castling.K ? 'K' : '',
      this.castling.Q ? 'Q' : '',
      this.castling.k ? 'k' : '',
      this.castling.q ? 'q' : '',
    ].join('') || '-';

    return [
      placement,
      this.activeColor,
      castleStr,
      this.enPassant || '-',
      this.halfmove,
      this.fullmove,
    ].join(' ');
  }

  getPiece(sq) { return this.squares.get(sq) || null; }
  setPiece(sq, code) { this.squares.set(sq, code); }
  clearSq(sq) { this.squares.delete(sq); }

  findKing(color) {
    const target = color === 'white' ? 'K' : 'k';
    for (const [sq, code] of this.squares) {
      if (code === target) return sq;
    }
    return null;
  }

  clone() {
    const gs = new GameState();
    gs.squares = new Map(this.squares);
    gs.castling = { ...this.castling };
    gs.enPassant = this.enPassant;
    gs.halfmove = this.halfmove;
    gs.fullmove = this.fullmove;
    gs.activeColor = this.activeColor;
    return gs;
  }
}

const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: Infinity };

function pieceValue(code) {
  return PIECE_VALUES[code.toLowerCase()] ?? 0;
}

module.exports = { GameState, STARTING_FEN, fileOf, rankOf, squareAt, colorOf, pieceType, pieceValue };
