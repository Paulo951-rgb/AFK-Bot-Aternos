/**
 * index.js — Minecraft AFK Bot  v2.0
 *
 * Architecture : State Machine  +  Exponential Backoff  +  Circuit Breaker
 * Target       : Aternos (PaperMC 1.21.1) on Render Free
 *
 * State diagram:
 *
 *   IDLE ──────► CONNECTING ──────► CONNECTED
 *     ▲                                  │
 *     │                                  ▼
 *   WAITING ◄──────────────────── (disconnect / error)
 */

'use strict';

const mineflayer = require('mineflayer');
const express    = require('express');
const fs         = require('fs');
const path       = require('path');

// ══════════════════════════════════════════════════════════════
// §1 — CONFIGURATION
// ══════════════════════════════════════════════════════════════

let rawSettings;
try {
  rawSettings = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf-8'),
  );
} catch (err) {
  console.error('[FATAL] Cannot read settings.json:', err.message);
  process.exit(1);
}

const CFG = Object.freeze({
  // Minecraft server
  host:    rawSettings.server.ip,
  port:    Number(rawSettings.server.port),
  version: rawSettings.server.version,

  // Bot credentials
  username: rawSettings.bot.username,
  auth:     rawSettings.bot.auth,

  // Anti-AFK
  antiAfkEnabled: rawSettings.antiAfk?.enabled  ?? true,
  antiAfkDelay:   rawSettings.antiAfk?.delay    ?? 30_000,

  // Reconnect / circuit-breaker tuning
  reconnect: {
    base:          20_000,  // 20s base delay
    max:          300_000,  // 5 min ceiling
    factor:           1.8,  // each attempt is ×1.8 the previous
    jitter:          0.25,  // ±25 % random variance
    tripAfter:          5,  // circuit trips after N consecutive failures
    tripCooldown:  600_000, // 10 min cool-down when circuit is tripped
    hardReset:         20,  // force counter reset after N total failures
  },

  // How long to wait for Mineflayer to receive the spawn packet
  // Aternos + Paper can take 60–90 s to load chunks after login
  spawnTimeout: 120_000, // 2 minutes

  // How long to wait before the very first connection attempt.
  // Aternos often shows "online" before PaperMC has fully initialised.
  startupDelay: 60_000, // 60 seconds
});

// ══════════════════════════════════════════════════════════════
// §2 — LOGGER
// ══════════════════════════════════════════════════════════════

function ts() { return new Date().toISOString(); }

const LOG = {
  info:  (...a) => console.log(ts(), '[INFO ]', ...a),
  warn:  (...a) => console.log(ts(), '[WARN ]', ...a),
  error: (...a) => console.error(ts(), '[ERROR]', ...a),
  bot:   (...a) => console.log(ts(), '[BOT  ]', ...a),
  net:   (...a) => console.log(ts(), '[NET  ]', ...a),
  state: (...a) => console.log(ts(), '[STATE]', ...a),
};

// ══════════════════════════════════════════════════════════════
// §3 — STATE MACHINE
// ══════════════════════════════════════════════════════════════

const State = Object.freeze({
  IDLE:       'IDLE',
  CONNECTING: 'CONNECTING',
  CONNECTED:  'CONNECTED',
  WAITING:    'WAITING',
});

let state = State.IDLE;

function transition(to, why = '') {
  if (to === state) return;
  LOG.state(`${state} → ${to}${why ? `  (${why})` : ''}`);
  state = to;
}

// ══════════════════════════════════════════════════════════════
// §4 — CIRCUIT BREAKER + RECONNECT SCHEDULER
// ══════════════════════════════════════════════════════════════

const CB = {
  attempts:    0,
  consecutive: 0,
  tripped:     false,
  timer:       null,
};

function backoffDelay() {
  if (CB.tripped) return CFG.reconnect.tripCooldown;

  const base = Math.min(
    CFG.reconnect.base * Math.pow(CFG.reconnect.factor, CB.attempts),
    CFG.reconnect.max,
  );
  const jitter = base * CFG.reconnect.jitter * (Math.random() * 2 - 1);
  return Math.max(5_000, Math.floor(base + jitter));
}

/**
 * Schedule a reconnect attempt with exponential backoff + jitter.
 *
 * Guard rails:
 *  - No-op if already WAITING / CONNECTED / CONNECTING.
 *  - Trips the circuit breaker after N consecutive failures.
 *  - Hard-resets all counters if total attempts exceed the ceiling.
 */
function scheduleReconnect(reason) {
  if (
    state === State.WAITING   ||
    state === State.CONNECTED ||
    state === State.CONNECTING
  ) {
    LOG.warn(`scheduleReconnect() ignored — current state: ${state}`);
    return;
  }

  // Clear any stale timer
  clearTimeout(CB.timer);
  CB.timer = null;

  CB.attempts++;
  CB.consecutive++;

  // Trip the circuit breaker
  if (!CB.tripped && CB.consecutive >= CFG.reconnect.tripAfter) {
    CB.tripped = true;
    LOG.warn(`⚡ Circuit breaker TRIPPED after ${CB.consecutive} consecutive failures`);
  }

  // Hard reset if we've been failing for a very long time
  if (CB.attempts > CFG.reconnect.hardReset) {
    LOG.warn('🔄 Hard reset — failure counters cleared');
    CB.attempts = 0; CB.consecutive = 0; CB.tripped = false;
  }

  const delay = backoffDelay();
  const label = delay >= 60_000
    ? `${(delay / 60_000).toFixed(1)} min`
    : `${(delay / 1_000).toFixed(1)} s`;

  LOG.net(
    `Reconnect #${CB.attempts} in ${label}` +
    `  —  reason: "${reason}"` +
    (CB.tripped ? '  [CIRCUIT TRIPPED]' : ''),
  );

  transition(State.WAITING, reason);

  CB.timer = setTimeout(() => {
    CB.timer = null;
    // Only proceed if we are still waiting (nothing else reconnected us)
    if (state === State.WAITING) {
      transition(State.IDLE, 'timer fired');
      createBot();
    }
  }, delay);
}

function onConnectSuccess() {
  CB.attempts    = 0;
  CB.consecutive = 0;
  CB.tripped     = false;
  LOG.net('✅ Circuit breaker RESET — connection healthy');
}

// ══════════════════════════════════════════════════════════════
// §5 — BOT LIFECYCLE
// ══════════════════════════════════════════════════════════════

let bot         = null;  // Single bot reference — always null when not connected
let spawnTimer  = null;  // Spawn-timeout handle
let afkInterval = null;  // Anti-AFK interval handle
let afkCycle    = 0;     // Action index for cycling through AFK moves

/**
 * Destroys ALL resources attached to the current bot instance:
 *   timers → intervals → event listeners → TCP socket → bot.end()
 *
 * Always sets `bot = null` before returning.
 * Safe to call multiple times (idempotent).
 */
function cleanupBot() {
  LOG.bot('🧹 Cleaning up…');

  // 1. Kill timers first so nothing can fire during cleanup
  if (spawnTimer)  { clearTimeout(spawnTimer);   spawnTimer  = null; }
  if (afkInterval) { clearInterval(afkInterval); afkInterval = null; }

  if (!bot) {
    LOG.bot('  Nothing to clean');
    return;
  }

  // 2. Grab and immediately null the reference so no other handler can use it
  const b = bot;
  bot = null;

  // 3. Remove all Mineflayer-level listeners
  try { b.removeAllListeners(); } catch (_) {}

  // 4. Destroy the raw TCP socket (ensures OS releases the connection)
  try {
    if (b._client?.socket) {
      b._client.socket.removeAllListeners();
      b._client.socket.destroy();
    }
  } catch (_) {}

  // 5. Remove internal minecraft-protocol client listeners
  try { b._client?.removeAllListeners(); } catch (_) {}

  // 6. Tell Mineflayer to end (no-op if already dead, but safe)
  try { b.end('cleanup'); } catch (_) {}

  LOG.bot('✅ Cleanup complete');
}

/**
 * Creates a Mineflayer bot and wires all event handlers.
 *
 * This function is protected by the state machine.
 * A `done` flag (per-invocation closure) prevents multiple event handlers
 * from triggering cleanup/reconnect concurrently.
 */
function createBot() {
  // ── Double-bot guard ──────────────────────────────────────────
  if (state === State.CONNECTING || state === State.CONNECTED) {
    LOG.warn(`createBot() blocked — already in state "${state}"`);
    return;
  }
  if (bot !== null) {
    LOG.warn('createBot() — stale bot reference, forcing cleanup first');
    cleanupBot();
  }
  // ──────────────────────────────────────────────────────────────

  transition(State.CONNECTING);
  LOG.bot(`📡 Connecting → ${CFG.host}:${CFG.port}  [Minecraft ${CFG.version}]`);

  // Per-invocation close flag.
  // Ensures that if 'end' fires, spawn-timeout fires, or 'error' causes end to fire,
  // only the FIRST handler actually performs cleanup and schedules a reconnect.
  let done = false;

  // ── Instantiate ──────────────────────────────────────────────
  try {
    bot = mineflayer.createBot({
      host:     CFG.host,
      port:     CFG.port,
      version:  CFG.version,
      username: CFG.username,
      auth:     CFG.auth,
    });
  } catch (err) {
    LOG.error('mineflayer.createBot() threw synchronously:', err.message);
    bot = null;
    transition(State.IDLE, 'create-threw');
    scheduleReconnect('create-error');
    return;
  }

  // ── Spawn timeout ─────────────────────────────────────────────
  //
  // Root cause of "INJECTION OK / never spawns":
  //   Aternos's proxy opens the port and accepts the TCP connection as soon as
  //   the Java process starts, but PaperMC still needs to load world chunks.
  //   The login handshake succeeds (inject_allowed + login fire) but Paper
  //   does not send the spawn packet until the world is ready — which can
  //   take 30–90 s on a cold Aternos start.
  //
  spawnTimer = setTimeout(() => {
    if (done) return;
    LOG.bot(`⏰ Spawn timeout (${CFG.spawnTimeout / 1000}s) — Paper may still be loading`);
    done = true;
    cleanupBot();
    if (state !== State.WAITING) {
      transition(State.IDLE, 'spawn-timeout');
      scheduleReconnect('spawn-timeout');
    }
  }, CFG.spawnTimeout);

  // ── inject_allowed ────────────────────────────────────────────
  // TCP connection established + Minecraft handshake OK.
  // Does NOT guarantee login or spawn will follow.
  bot.on('inject_allowed', () => {
    LOG.net('→ inject_allowed: TCP + handshake OK');
  });

  // ── login ─────────────────────────────────────────────────────
  // Server accepted the account credentials.
  bot.on('login', () => {
    LOG.bot('→ login: account accepted by server');
  });

  // ── spawn ─────────────────────────────────────────────────────
  // The player entity now exists in the world. The bot is fully online.
  bot.once('spawn', () => {
    if (done) return;

    clearTimeout(spawnTimer);
    spawnTimer = null;

    const p = bot?.entity?.position;
    const posStr = p
      ? `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`
      : '(unknown)';

    LOG.bot(`✅ Spawned as "${bot?.username ?? '?'}" at ${posStr}`);
    transition(State.CONNECTED, 'spawn');
    onConnectSuccess();

    if (CFG.antiAfkEnabled) startAntiAfk();
  });

  // ── kicked ────────────────────────────────────────────────────
  // Log kick reason. The 'end' event always fires immediately after.
  bot.on('kicked', (reason) => {
    let text = reason;
    try { if (typeof reason !== 'string') text = JSON.stringify(reason); }
    catch (_) {}
    LOG.bot(`👢 Kicked: ${text}`);
  });

  // ── error ─────────────────────────────────────────────────────
  // Network-level errors. The 'end' event always fires after 'error'.
  // We log and diagnose here; reconnect logic lives entirely in 'end'.
  bot.on('error', (err) => {
    const code = err.code ?? 'UNKNOWN';
    LOG.net(`Network error [${code}]: ${err.message}`);

    const notes = {
      ETIMEDOUT:
        '  → TCP timeout: server port unreachable ' +
        '(Aternos not ready, overloaded, or wrong port)',
      ECONNRESET:
        '  → Connection reset by remote: Paper closed the socket ' +
        '(restart, crash, or network hiccup)',
      ECONNREFUSED:
        '  → Connection refused: port closed (server is fully offline)',
      ENOTFOUND:
        '  → DNS failure: hostname not resolved (Aternos DNS outage)',
      EPIPE:
        '  → Broken pipe: server closed connection during a write',
    };
    if (notes[code]) LOG.net(notes[code]);
  });

  // ── end ───────────────────────────────────────────────────────
  // Fired for every disconnection, after 'error', 'kicked', or a clean logout.
  // This is the SINGLE point of reconnect scheduling — never schedule elsewhere.
  bot.on('end', (reason) => {
    if (done) return;
    done = true;

    LOG.bot(`🔌 Disconnected: "${reason ?? 'no reason given'}"`);
    cleanupBot();

    if (state !== State.WAITING) {
      transition(State.IDLE, `end:${reason ?? 'unknown'}`);
      scheduleReconnect(reason ?? 'end');
    }
  });
}

// ══════════════════════════════════════════════════════════════
// §6 — ANTI-AFK
// ══════════════════════════════════════════════════════════════
//
// Movements are intentionally simple — no pathfinding, no physics engine.
// Named functions so action.name appears in logs for easy debugging.

const AFK_ACTIONS = [
  function jump()      { bot?.setControlState('jump',    true);  setTimeout(() => bot?.setControlState('jump',    false), 5050); },
  function forward()   { bot?.setControlState('forward', true);  setTimeout(() => bot?.setControlState('forward', false), 8500); },
  function back()      { bot?.setControlState('back',    true);  setTimeout(() => bot?.setControlState('back',    false), 8067); },
  function strafeLeft(){ bot?.setControlState('left',    true);  setTimeout(() => bot?.setControlState('left',    false), 8300); },
  function strafeRight(){ bot?.setControlState('right',  true);  setTimeout(() => bot?.setControlState('right',   false), 8060); },
  function look()      { if (bot?.entity) bot.look(bot.entity.yaw + 0.75, 0, true); },
];

function startAntiAfk() {
  if (afkInterval) clearInterval(afkInterval);
  afkCycle = 0;

  afkInterval = setInterval(() => {
    if (!bot || state !== State.CONNECTED) return;
    try {
      const action = AFK_ACTIONS[afkCycle % AFK_ACTIONS.length];
      action();
      LOG.bot(`Anti-AFK → ${action.name}  (cycle ${afkCycle + 1})`);
      afkCycle++;
    } catch (err) {
      LOG.warn(`Anti-AFK error: ${err.message}`);
    }
  }, CFG.antiAfkDelay);

  LOG.bot(`🎮 Anti-AFK started  (every ${CFG.antiAfkDelay / 1000}s)`);
}

// ══════════════════════════════════════════════════════════════
// §7 — EXPRESS HEALTH SERVER
// ══════════════════════════════════════════════════════════════
//
// Required by Render: a bound HTTP port signals that the service is alive.
// Without it, Render considers the process dead and kills it.
// Also useful for external monitoring (e.g. UptimeRobot).

function startHealthServer() {
  const app  = express();
  const PORT = process.env.PORT || 3000;

  // Full status — useful while debugging
  app.get('/', (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
      status:  'running',
      time:    new Date().toISOString(),
      uptime:  `${Math.floor(process.uptime())}s`,
      bot: {
        state,
        username:  bot?.username ?? null,
        tripped:   CB.tripped,
        attempts:  CB.attempts,
      },
      server: { host: CFG.host, port: CFG.port, version: CFG.version },
      memory: {
        rss:      `${(mem.rss       / 1024 / 1024).toFixed(1)} MB`,
        heapUsed: `${(mem.heapUsed  / 1024 / 1024).toFixed(1)} MB`,
      },
    });
  });

  // Minimal health-check endpoint — Render and UptimeRobot hit this
  app.get('/health', (_req, res) => res.status(200).send('OK'));

  app.listen(PORT, () => LOG.info(`🌐 Health server on port ${PORT}`));
}

// ══════════════════════════════════════════════════════════════
// §8 — PROCESS GUARDS
// ══════════════════════════════════════════════════════════════

// Catch unhandled errors without crashing the process.
// If process.exit() were called here, Render would trigger a redeploy,
// which resets the startup timer and disconnects the bot.
process.on('uncaughtException', (err) => {
  LOG.error('Uncaught exception:', err.message);
  LOG.error(err.stack);
  // Do NOT exit — let the bot recover naturally via its reconnect logic.
});

process.on('unhandledRejection', (reason) => {
  LOG.error('Unhandled rejection:', reason);
});

// Render sends SIGTERM before gracefully restarting the service.
// We have a few seconds to clean up before the process is killed.
process.on('SIGTERM', () => {
  LOG.info('SIGTERM received — shutting down gracefully');
  cleanupBot();
  clearTimeout(CB.timer);
  process.exit(0);
});

process.on('SIGINT', () => {
  LOG.info('SIGINT received — shutting down gracefully');
  cleanupBot();
  clearTimeout(CB.timer);
  process.exit(0);
});

// ══════════════════════════════════════════════════════════════
// §9 — STARTUP SEQUENCE
// ══════════════════════════════════════════════════════════════

LOG.info('══════════════════════════════════════════════');
LOG.info('  Minecraft AFK Bot  ·  v2.0');
LOG.info(`  ${CFG.host}:${CFG.port}  [Minecraft ${CFG.version}]`);
LOG.info(`  Username : ${CFG.username}  |  Auth: ${CFG.auth}`);
LOG.info(`  Anti-AFK : ${CFG.antiAfkEnabled ? `every ${CFG.antiAfkDelay / 1000}s` : 'disabled'}`);
LOG.info('══════════════════════════════════════════════');

startHealthServer();

LOG.info(`⏳ Waiting ${CFG.startupDelay / 1000}s for Aternos to fully initialize…`);
LOG.info('   (Aternos shows "online" before PaperMC has loaded chunks — this delay prevents spawn-timeout loops)');

setTimeout(() => {
  LOG.info('🚀 Startup delay complete — launching bot');
  createBot();
}, CFG.startupDelay);
