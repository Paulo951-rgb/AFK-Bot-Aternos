'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const mineflayer = require('mineflayer');

const State = Object.freeze({
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  WAITING: 'WAITING',
  STOPPING: 'STOPPING',
});

const DEFAULTS = Object.freeze({
  antiAfkDelay: 30000,
  startupDelay: 60000,
  spawnTimeout: 120000,
  reconnect: {
    baseDelay: 20000,
    maxDelay: 300000,
    factor: 1.8,
    jitter: 0.25,
    tripAfter: 5,
    tripCooldown: 600000,
    hardResetAfter: 20,
  },
});

function now() {
  return new Date().toISOString();
}

const log = {
  info: (...args) => console.log(now(), '[INFO ]', ...args),
  warn: (...args) => console.warn(now(), '[WARN ]', ...args),
  error: (...args) => console.error(now(), '[ERROR]', ...args),
  state: (...args) => console.log(now(), '[STATE]', ...args),
  bot: (...args) => console.log(now(), '[BOT  ]', ...args),
  net: (...args) => console.log(now(), '[NET  ]', ...args),
};

function readSettings() {
  const file = path.join(__dirname, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const host = settings.server && settings.server.ip;
  const port = Number(settings.server && settings.server.port);
  const version = settings.server && settings.server.version;
  const username = settings.bot && settings.bot.username;
  const auth = (settings.bot && settings.bot.auth) || 'offline';

  if (!host) throw new Error('settings.server.ip is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('settings.server.port must be a valid TCP port');
  }
  if (!version) throw new Error('settings.server.version is required');
  if (!username) throw new Error('settings.bot.username is required');

  return Object.freeze({
    host,
    port,
    version,
    username,
    auth,
    antiAfkEnabled: settings.antiAfk && settings.antiAfk.enabled !== undefined ? settings.antiAfk.enabled : true,
    antiAfkDelay: Number((settings.antiAfk && settings.antiAfk.delay) || DEFAULTS.antiAfkDelay),
    startupDelay: Number((settings.startup && settings.startup.delay) || DEFAULTS.startupDelay),
    spawnTimeout: Number((settings.timeouts && settings.timeouts.spawn) || DEFAULTS.spawnTimeout),
    reconnect: Object.freeze({
      baseDelay: Number((settings.reconnect && settings.reconnect.baseDelay) || DEFAULTS.reconnect.baseDelay),
      maxDelay: Number((settings.reconnect && settings.reconnect.maxDelay) || DEFAULTS.reconnect.maxDelay),
      factor: Number((settings.reconnect && settings.reconnect.factor) || DEFAULTS.reconnect.factor),
      jitter: Number((settings.reconnect && settings.reconnect.jitter) || DEFAULTS.reconnect.jitter),
      tripAfter: Number((settings.reconnect && settings.reconnect.tripAfter) || DEFAULTS.reconnect.tripAfter),
      tripCooldown: Number((settings.reconnect && settings.reconnect.tripCooldown) || DEFAULTS.reconnect.tripCooldown),
      hardResetAfter: Number((settings.reconnect && settings.reconnect.hardResetAfter) || DEFAULTS.reconnect.hardResetAfter),
    }),
  });
}

let config;
try {
  config = readSettings();
} catch (error) {
  log.error('Invalid settings.json:', error.message);
  process.exit(1);
}

let state = State.IDLE;
let bot = null;
let spawnTimer = null;
let afkInterval = null;
let reconnectTimer = null;
let afkCycle = 0;
let startedAt = Date.now();
let lastDisconnectReason = null;

const circuitBreaker = {
  attempts: 0,
  consecutiveFailures: 0,
  tripped: false,
};

function transition(nextState, reason) {
  reason = reason || '';
  if (state === nextState) return;
  log.state(state + ' -> ' + nextState + (reason ? ' (' + reason + ')' : ''));
  state = nextState;
}

function formatDelay(ms) {
  if (ms >= 60000) return (ms / 60000).toFixed(1) + ' min';
  return (ms / 1000).toFixed(1) + ' s';
}

function computeReconnectDelay() {
  if (circuitBreaker.tripped) return config.reconnect.tripCooldown;
  const exponentialDelay = Math.min(
    config.reconnect.baseDelay * Math.pow(config.reconnect.factor, circuitBreaker.attempts - 1),
    config.reconnect.maxDelay,
  );
  const jitterRange = exponentialDelay * config.reconnect.jitter;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(5000, Math.floor(exponentialDelay + jitter));
}

function clearLifecycleTimers() {
  if (spawnTimer) {
    clearTimeout(spawnTimer);
    spawnTimer = null;
  }
  if (afkInterval) {
    clearInterval(afkInterval);
    afkInterval = null;
  }
}

function cleanupBot() {
  clearLifecycleTimers();
  if (!bot) return;

  const currentBot = bot;
  bot = null;

  try {
    currentBot.removeAllListeners();
  } catch (error) {
    log.warn('Could not remove bot listeners:', error.message);
  }

  try {
    if (currentBot._client) currentBot._client.removeAllListeners();
    if (currentBot._client && currentBot._client.socket) {
      currentBot._client.socket.removeAllListeners();
      currentBot._client.socket.destroy();
    }
  } catch (error) {
    log.warn('Could not destroy Minecraft socket:', error.message);
  }

  try {
    currentBot.end('cleanup');
  } catch (error) {
    log.warn('Could not end Mineflayer bot cleanly:', error.message);
  }
}

function resetCircuitBreaker() {
  circuitBreaker.attempts = 0;
  circuitBreaker.consecutiveFailures = 0;
  circuitBreaker.tripped = false;
  log.net('Circuit breaker reset after successful spawn');
}

function scheduleReconnect(reason) {
  if (state === State.STOPPING) return;
  if (state === State.CONNECTING || state === State.CONNECTED || state === State.WAITING) {
    log.warn('Reconnect ignored because state is ' + state);
    return;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  circuitBreaker.attempts += 1;
  circuitBreaker.consecutiveFailures += 1;

  if (!circuitBreaker.tripped && circuitBreaker.consecutiveFailures >= config.reconnect.tripAfter) {
    circuitBreaker.tripped = true;
    log.warn('Circuit breaker tripped after ' + circuitBreaker.consecutiveFailures + ' consecutive failures');
  }

  if (circuitBreaker.attempts > config.reconnect.hardResetAfter) {
    log.warn('Reconnect counters hard-reset after prolonged failures');
    circuitBreaker.attempts = 1;
    circuitBreaker.consecutiveFailures = 1;
    circuitBreaker.tripped = false;
  }

  const delay = computeReconnectDelay();
  lastDisconnectReason = reason;
  log.net('Reconnect #' + circuitBreaker.attempts + ' scheduled in ' + formatDelay(delay) + '; reason=' + reason + (circuitBreaker.tripped ? '; circuit=tripped' : ''));

  transition(State.WAITING, reason);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (state !== State.WAITING) return;
    transition(State.IDLE, 'reconnect timer fired');
    createBot();
  }, delay);
}

function finishConnectionCycle(doneRef, reason) {
  if (doneRef.done) return false;
  doneRef.done = true;
  cleanupBot();
  if (state !== State.STOPPING) {
    transition(State.IDLE, reason);
    scheduleReconnect(reason);
  }
  return true;
}

function createBot() {
  if (state !== State.IDLE) {
    log.warn('createBot ignored because state is ' + state);
    return;
  }
  if (bot) {
    log.warn('Stale bot reference found before connect; cleaning up');
    cleanupBot();
  }

  transition(State.CONNECTING, 'createBot');
  log.bot('Connecting to ' + config.host + ':' + config.port + ' with Minecraft ' + config.version);

  const doneRef = { done: false };

  try {
    bot = mineflayer.createBot({
      host: config.host,
      port: config.port,
      username: config.username,
      auth: config.auth,
      hideErrors: false,
    });
  } catch (error) {
    log.error('mineflayer.createBot failed synchronously:', error.message);
    bot = null;
    transition(State.IDLE, 'createBot error');
    scheduleReconnect('createBot-error');
    return;
  }

  spawnTimer = setTimeout(() => {
    log.warn('Spawn timeout after ' + formatDelay(config.spawnTimeout));
    finishConnectionCycle(doneRef, 'spawn-timeout');
  }, config.spawnTimeout);

  bot.on('inject_allowed', () => {
    log.net('Handshake accepted by Mineflayer');
  });

  bot.on('login', () => {
    log.bot('Login accepted by server');
  });

  bot.once('spawn', () => {
    if (doneRef.done) return;
    clearLifecycleTimers();

    const position = bot && bot.entity && bot.entity.position;
    const location = position
      ? Math.round(position.x) + ', ' + Math.round(position.y) + ', ' + Math.round(position.z)
      : 'unknown';

    transition(State.CONNECTED, 'spawn');
    resetCircuitBreaker();
    log.bot('Spawned as ' + ((bot && bot.username) || config.username) + ' at ' + location);

    if (config.antiAfkEnabled) startAntiAfk();
  });

  bot.on('kicked', (reason) => {
    log.warn('Kicked by server: ' + stringifyReason(reason));
  });

  bot.on('error', (error) => {
    const code = (error && error.code) || 'UNKNOWN';
    log.net('Network error ' + code + ': ' + ((error && error.message) || error));
    logNetworkHint(code);
  });

  bot.on('end', (reason) => {
    const text = stringifyReason(reason || 'connection-ended');
    log.bot('Disconnected: ' + text);
    finishConnectionCycle(doneRef, 'end:' + text);
  });
}

function stringifyReason(reason) {
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason);
  } catch (_error) {
    return String(reason);
  }
}

function logNetworkHint(code) {
  const hints = {
    ETIMEDOUT: 'TCP timeout: Aternos port is not reachable yet, or the server is overloaded.',
    ECONNRESET: 'Remote reset: Paper, Aternos, or the network closed the socket abruptly.',
    ECONNREFUSED: 'Connection refused: TCP port is closed, usually because the server is offline.',
    ENOTFOUND: 'DNS failure: the Aternos hostname could not be resolved.',
    EPIPE: 'Broken pipe: the socket closed while Mineflayer was writing.',
  };
  if (hints[code]) log.net(hints[code]);
}

const antiAfkActions = [
  function jump() {
    if (!bot) return;
    bot.setControlState('jump', true);
    setTimeout(() => { if (bot) bot.setControlState('jump', false); }, 500);
  },
  function forward() {
    if (!bot) return;
    bot.setControlState('forward', true);
    setTimeout(() => { if (bot) bot.setControlState('forward', false); }, 800);
  },
  function back() {
    if (!bot) return;
    bot.setControlState('back', true);
    setTimeout(() => { if (bot) bot.setControlState('back', false); }, 800);
  },
  function strafeLeft() {
    if (!bot) return;
    bot.setControlState('left', true);
    setTimeout(() => { if (bot) bot.setControlState('left', false); }, 800);
  },
  function strafeRight() {
    if (!bot) return;
    bot.setControlState('right', true);
    setTimeout(() => { if (bot) bot.setControlState('right', false); }, 800);
  },
  function lookAround() {
    if (!bot || !bot.entity) return;
    bot.look(bot.entity.yaw + 0.75, bot.entity.pitch, true);
  },
];

function startAntiAfk() {
  if (afkInterval) clearInterval(afkInterval);
  afkCycle = 0;

  afkInterval = setInterval(() => {
    if (state !== State.CONNECTED || !bot) return;
    const action = antiAfkActions[afkCycle % antiAfkActions.length];
    try {
      action();
      afkCycle += 1;
      log.bot('Anti-AFK action: ' + action.name + '; cycle=' + afkCycle);
    } catch (error) {
      log.warn('Anti-AFK action failed: ' + error.message);
    }
  }, config.antiAfkDelay);

  log.bot('Anti-AFK started; interval=' + formatDelay(config.antiAfkDelay));
}

function startHealthServer() {
  const app = express();
  const port = Number(process.env.PORT || 3000);

  app.get('/health', (_request, response) => {
    response.status(200).json({
      ok: true,
      state,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  app.get('/', (_request, response) => {
    const memory = process.memoryUsage();
    response.status(200).json({
      service: 'minecraft-afk-bot',
      ok: true,
      state,
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt: new Date(startedAt).toISOString(),
      lastDisconnectReason,
      bot: {
        username: bot ? bot.username : null,
        antiAfkEnabled: config.antiAfkEnabled,
      },
      minecraft: {
        host: config.host,
        port: config.port,
        version: config.version,
      },
      reconnect: {
        attempts: circuitBreaker.attempts,
        consecutiveFailures: circuitBreaker.consecutiveFailures,
        tripped: circuitBreaker.tripped,
      },
      memory: {
        rssMb: Number((memory.rss / 1024 / 1024).toFixed(1)),
        heapUsedMb: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
      },
    });
  });

  app.listen(port, () => {
    log.info('Health server listening on port ' + port);
  });
}

function shutdown(signal) {
  log.info(signal + ' received; shutting down');
  transition(State.STOPPING, signal);
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  cleanupBot();
  process.exit(0);
}

process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error.message);
  log.error(error.stack);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log.info('Minecraft AFK Bot v2.0 starting');
log.info('Target: ' + config.host + ':' + config.port + '; version=' + config.version + '; username=' + config.username);
log.info('Startup delay: ' + formatDelay(config.startupDelay) + '; spawn timeout: ' + formatDelay(config.spawnTimeout));

startHealthServer();

setTimeout(() => {
  if (state !== State.IDLE) return;
  log.info('Startup delay complete; starting Minecraft connection');
  createBot();
}, config.startupDelay);
