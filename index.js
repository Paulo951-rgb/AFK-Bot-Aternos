'use strict';

const mineflayer = require('mineflayer');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════

const rawSettings = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf-8')
);

const CFG = Object.freeze({
  host: rawSettings.server.ip,
  port: Number(rawSettings.server.port),
  version: rawSettings.server.version,

  username: rawSettings.bot.username,
  auth: rawSettings.bot.auth,

  antiAfkEnabled: rawSettings.antiAfk?.enabled ?? true,
  antiAfkDelay: rawSettings.antiAfk?.delay ?? 30000,

  spawnTimeout: 120000,
  startupDelay: 60000,

  reconnect: {
    base: 20000,
    max: 300000,
    factor: 1.8,
    jitter: 0.25,
    tripAfter: 5,
    tripCooldown: 600000,
    hardReset: 20,
  }
});

// ══════════════════════════════════════════════════════
// LOGGER
// ══════════════════════════════════════════════════════

const ts = () => new Date().toISOString();

const LOG = {
  info: (...a) => console.log(ts(), '[INFO ]', ...a),
  warn: (...a) => console.log(ts(), '[WARN ]', ...a),
  error: (...a) => console.log(ts(), '[ERROR]', ...a),
  bot: (...a) => console.log(ts(), '[BOT  ]', ...a),
  net: (...a) => console.log(ts(), '[NET  ]', ...a),
  state: (...a) => console.log(ts(), '[STATE]', ...a),
};

// ══════════════════════════════════════════════════════
// STATE MACHINE
// ══════════════════════════════════════════════════════

const State = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  WAITING: 'WAITING',
};

let state = State.IDLE;
let bot = null;

// ══════════════════════════════════════════════════════
// CIRCUIT BREAKER
// ══════════════════════════════════════════════════════

const CB = {
  attempts: 0,
  consecutive: 0,
  tripped: false,
  timer: null,
};

function transition(to, why) {
  if (to === state) return;
  LOG.state(`${state} → ${to}${why ? ` (${why})` : ''}`);
  state = to;
}

// ══════════════════════════════════════════════════════
// BOT CLEANUP SAFE
// ══════════════════════════════════════════════════════

let spawnTimer = null;
let afkTimer = null;
let physicsBound = false;

function cleanupBot() {
  LOG.bot('🧹 cleanup');

  if (spawnTimer) clearTimeout(spawnTimer);
  if (afkTimer) clearInterval(afkTimer);

  spawnTimer = null;
  afkTimer = null;

  if (!bot) return;

  try { bot.removeAllListeners(); } catch {}
  try { bot._client?.removeAllListeners(); } catch {}
  try { bot._client?.socket?.destroy(); } catch {}
  try { bot.end(); } catch {}

  bot = null;
}

// ══════════════════════════════════════════════════════
// AFK SYSTEM (FIXED - NO DUPLICATES)
// ══════════════════════════════════════════════════════

const AFK_ACTIONS = [
  () => bot?.setControlState('forward', true),
  () => bot?.setControlState('forward', false),

  () => bot?.setControlState('jump', true),
  () => bot?.setControlState('jump', false),

  () => {
    if (!bot?.entity) return;
    bot.look(
      bot.entity.yaw + (Math.random() - 0.5),
      (Math.random() - 0.5) * 0.3,
      true
    );
  }
];

let afkIndex = 0;

function startAntiAfk() {
  if (afkTimer) clearInterval(afkTimer);

  afkIndex = 0;

  afkTimer = setInterval(() => {
    if (!bot || state !== State.CONNECTED) return;

    const action = AFK_ACTIONS[afkIndex % AFK_ACTIONS.length];
    action();

    LOG.bot(`AFK → ${action.name || 'action'} #${afkIndex}`);
    afkIndex++;
  }, CFG.antiAfkDelay);

  LOG.bot('🎮 Anti-AFK ON');
}

// ══════════════════════════════════════════════════════
// CREATE BOT
// ══════════════════════════════════════════════════════

function createBot() {
  if (state !== State.IDLE) return;

  transition(State.CONNECTING);

  LOG.bot(`Connecting ${CFG.host}:${CFG.port}`);

  let done = false;

  try {
    bot = mineflayer.createBot({
      host: CFG.host,
      port: CFG.port,
      username: CFG.username,
      auth: CFG.auth,
      version: CFG.version,
    });
  } catch (e) {
    LOG.error('createBot crash', e);
    transition(State.IDLE);
    return;
  }

  spawnTimer = setTimeout(() => {
    if (done) return;
    done = true;

    LOG.bot('❌ spawn timeout');
    cleanupBot();

    transition(State.IDLE, 'timeout');
    scheduleReconnect('spawn-timeout');
  }, CFG.spawnTimeout);

  bot.once('spawn', () => {
    if (done) return;
    done = true;

    clearTimeout(spawnTimer);

    LOG.bot('✅ spawned');

    transition(State.CONNECTED, 'spawn');

    CB.attempts = 0;
    CB.consecutive = 0;
    CB.tripped = false;

    if (CFG.antiAfkEnabled) startAntiAfk();

    // FIXED physicsTick INSIDE spawn
    if (!physicsBound) {
      physicsBound = true;

      bot.on('physicsTick', () => {
        if (!bot?.entity) return;

        const mob = bot.nearestEntity(e =>
          e.type === 'mob' &&
          e.position.distanceTo(bot.entity.position) < 4
        );

        if (mob) {
          bot.lookAt(mob.position);
          bot.attack(mob);
        }
      });
    }
  });

  bot.on('end', (r) => {
    if (done) return;
    done = true;

    LOG.bot('disconnect:', r);

    cleanupBot();

    transition(State.IDLE, 'end');
    scheduleReconnect(r);
  });

  bot.on('error', (e) => {
    LOG.net(e.code || 'error', e.message);
  });
}

// ══════════════════════════════════════════════════════
// RECONNECT (FIXED SIMPLE)
// ══════════════════════════════════════════════════════

function backoff() {
  const base = Math.min(
    CFG.reconnect.base * Math.pow(CFG.reconnect.factor, CB.attempts),
    CFG.reconnect.max
  );

  const jitter = base * CFG.reconnect.jitter * (Math.random() * 2 - 1);
  return Math.max(5000, base + jitter);
}

function scheduleReconnect(reason) {
  if (state !== State.IDLE) return;

  CB.attempts++;
  CB.consecutive++;

  const delay = backoff();

  LOG.net(`Reconnect in ${Math.round(delay/1000)}s (${reason})`);

  transition(State.WAITING);

  setTimeout(() => {
    transition(State.IDLE, 'retry');
    createBot();
  }, delay);
}

// ══════════════════════════════════════════════════════
// EXPRESS
// ══════════════════════════════════════════════════════

const app = express();

app.get('/', (_, res) => {
  res.json({
    state,
    connected: !!bot,
  });
});

app.listen(process.env.PORT || 3000);

// ══════════════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════════════

LOG.info('starting bot...');

setTimeout(() => {
  createBot();
}, CFG.startupDelay);
