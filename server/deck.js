// Card model + deck utilities for Kaabo (a Cabo/Kaboo-style game).

const SUITS = ['S', 'H', 'D', 'C']; // spades, hearts, diamonds, clubs
const RED_SUITS = new Set(['H', 'D']);
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function valueOf(rank, suit) {
  if (rank === 'K') return RED_SUITS.has(suit) ? -1 : 13;
  if (rank === 'A') return 1;
  if (rank === 'J') return 11;
  if (rank === 'Q') return 12;
  return parseInt(rank, 10);
}

function powerOf(rank) {
  if (rank === '7' || rank === '8') return 'peek-self';
  if (rank === '9' || rank === '10') return 'peek-opponent';
  if (rank === 'J' || rank === 'Q') return 'blind-swap';
  if (rank === 'K') return 'king';
  return null;
}

let nextCardId = 1;

function buildDeck() {
  const cards = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      cards.push({
        id: `c${nextCardId++}`,
        suit,
        rank,
        value: valueOf(rank, suit),
        power: powerOf(rank),
      });
    }
  }
  return cards;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { buildDeck, shuffle, valueOf, powerOf, SUITS, RANKS, RED_SUITS };
