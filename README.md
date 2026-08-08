# Kaabo

A local-network multiplayer card game inspired by Cabo/Kaboo — memory, nerve,
and a little bit of luck. One person hosts, everyone else joins from a phone
browser on the same WiFi network or mobile hotspot. No app installs, no
internet required once the host is running.

## How hosting works

Kaabo needs one device to run a small [Node.js](https://nodejs.org) server —
that device is the **host**. Every other player just opens a web browser.
A laptop is the easiest host device. An Android phone works too via
[Termux](https://termux.dev) (`pkg install nodejs-lts`); iPhones cannot run
Node.js, so an iPhone can only be a *player*, not the host.

1. Get everyone on the same network: turn on the host device's mobile
   hotspot (or use whatever WiFi router is nearby) and have everyone else
   connect to it.
2. On the host device:
   ```
   npm install
   npm start
   ```
3. The terminal prints one or more addresses like `http://192.168.43.1:3000`.
   Open that address in the host's own browser too — the host is a player
   like anyone else.
4. Everyone else opens the same address in their phone's browser (Safari,
   Chrome, whatever). They'll land on the same lobby.
5. Tap **Join a Game** and enter the room code shown on the host's screen
   (it's also pre-filled automatically if there's only one open lobby).
6. Once 2–8 players are in, the host taps **Start Game**.

If the host's IP address changes (e.g. they reconnect to the hotspot),
just re-run `npm start` and re-share the new address.

## Rules

Full rules are in the app itself (tap **How do I play?** on the landing
screen, or **Rules** from the lobby). Summary:

- Everyone has 4 face-down cards. Lowest total wins. Ace = 1, number cards =
  face value, J = 11, Q = 12, black King = 13, **red King = −1**.
- You may look at your own bottom two cards once, at the start of a round.
- On your turn: draw from the draw pile or the discard pile, then swap it
  into your row or discard it (drawing from the discard pile always
  requires a swap).
- If you discard a card straight from a draw-pile draw and it has a power,
  you may use it: **7/8** peek your own card, **9/10** peek an opponent's
  card, **J/Q** blind-swap any two cards, **King** look at two cards then
  choose whether to swap them.
- Anytime a card lands on the discard pile, anyone can try to **slap** a
  matching rank from their own row onto it, even out of turn. Right guess =
  one fewer card. Wrong guess = a penalty card.
- Call **Kaabo** instead of drawing to end the round. Everyone else gets one
  final turn, then all cards are revealed. If your total isn't strictly the
  lowest, you take a +10 penalty.
- Scores add up across rounds. Once someone crosses the target score
  (default 100, adjustable by the host in the lobby), the player with the
  lowest cumulative score wins.

## Project layout

```
server/
  index.js   Express + Socket.IO server, LAN IP detection
  rooms.js   In-memory room registry
  game.js    Game rules engine (the Room class)
  deck.js    Card model and deck utilities
public/
  index.html Single-page app shell (all screens)
  css/       Design system
  js/app.js  Client rendering + socket event handling
```

The server is authoritative: it tracks who has actually seen which card and
only ever sends a player the cards they're allowed to know, so there's no
way to open dev tools and see opponents' hands.
