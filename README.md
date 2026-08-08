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

## Playing over the internet instead of a hotspot

Nothing about the game logic requires a local network — it's just Socket.IO
over HTTP, so it works the same way if the server happens to live in the
cloud instead of on someone's laptop. If your group isn't in the same room,
deploy the server once and share the public URL instead of a hotspot address:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dhruvch1244/kaabo/tree/claude/kabboo-local-multiplayer-game-5lcwsm)

This repo includes a `render.yaml`, so Render's free tier will build and run
it automatically — click the button, connect your GitHub account, and Render
gives you a permanent `https://kaabo-xxxx.onrender.com` link you can send to
anyone. Two caveats: free-tier services spin down after 15 minutes idle (the
first request after that takes ~30s to wake back up), and since everyone now
connects over the internet rather than a shared hotspot, the in-app address
list on the lobby screen (which detects the *server's* local network IP) isn't
meaningful there — just share the Render URL directly instead.

## Getting a shareable link to the code itself

This session's GitHub access is scoped to pushing only the
`claude/kabboo-local-multiplayer-game-5lcwsm` branch — it can't push tags or
create a GitHub Release. Until this is merged or you tag it yourself, the
shareable link to the code is the branch itself:
`https://github.com/dhruvch1244/kaabo/tree/claude/kabboo-local-multiplayer-game-5lcwsm`
(add `.zip` via `.../archive/refs/heads/claude/kabboo-local-multiplayer-game-5lcwsm.zip`
for a direct download). To get a proper versioned Release, either merge this
branch into `main` and tag it from the GitHub UI (Releases → Draft a new
release), or ask for a pull request to be opened and merged first.

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
