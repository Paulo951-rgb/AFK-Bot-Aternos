const mineflayer = require('mineflayer');
const express = require('express');
const config = require('./settings.json');

// ======================================================
// CRASH PROTECTION
// ======================================================

process.on('uncaughtException', (err) => {
  console.log('[Crash] Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.log('[Crash] Unhandled Rejection:', reason);
});

// ======================================================
// EXPRESS (RENDER KEEP ALIVE)
// ======================================================

const app = express();
const PORT = process.env.PORT || 10000;

let botConnected = false;

app.get('/', (_, res) => {
  res.send('Minecraft AFK Bot Online');
});

app.get('/health', (_, res) => {
  res.json({ status: botConnected ? 'online' : 'offline' });
});

app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});

// ======================================================
// VARIABLES
// ======================================================

let bot = null;

let reconnecting = false;
let reconnectTimeout = null;

let antiAfkInterval = null;

let lastConnectAttempt = 0;

// ======================================================
// CLEAN BOT SAFE
// ======================================================

function cleanupBot() {
  if (antiAfkInterval) {
    clearInterval(antiAfkInterval);
    antiAfkInterval = null;
  }

  if (bot) {
    try {
      bot.removeAllListeners();
      bot.quit();
    } catch (e) {}
  }

  bot = null;
  botConnected = false;
}

// ======================================================
// ANTI AFK
// ======================================================

function startAntiAfk() {
  if (!config.antiAfk.enabled) return;

  if (antiAfkInterval) clearInterval(antiAfkInterval);

  console.log('[Bot] Anti AFK started');

  antiAfkInterval = setInterval(() => {
    if (!bot || !bot.entity) return;

    const actions = ['jump', 'forward', 'left', 'right'];
    const action = actions[Math.floor(Math.random() * actions.length)];

    bot.setControlState(action, true);

    setTimeout(() => {
      if (!bot) return;
      bot.setControlState(action, false);
    }, 1000);

  }, config.antiAfk.delay);
}

// ======================================================
// RECONNECT SAFE (ANTI SPAM + ATERNOS FIX)
// ======================================================

function scheduleReconnect(reason = 'unknown') {
  if (!config.reconnect.enabled) return;
  if (reconnecting) return;

  reconnecting = true;

  console.log(`[Bot] Reconnecting because: ${reason}`);

  cleanupBot();

  if (reconnectTimeout) clearTimeout(reconnectTimeout);

  let delay = config.reconnect.delay || 15000;

  if (
    reason === 'end' ||
    reason === 'kicked' ||
    reason === 'spawn-timeout'
  ) {
    delay = 8000;
  }

  reconnectTimeout = setTimeout(() => {
    reconnecting = false;
    createBot();
  }, delay);
}

// ======================================================
// CREATE BOT (SAFE + ATERNOS FIX)
// ======================================================

function createBot() {

  const now = Date.now();

  // ❌ anti spam connexion
  if (now - lastConnectAttempt < 12000) {
    console.log('[Bot] Waiting anti-spam delay...');
    return;
  }

  lastConnectAttempt = now;

  if (bot && bot._client && !bot._client.socket.destroyed) {
    console.log('[Bot] Bot already exists');
    return;
  }

  console.log('====================================');
  console.log('[Bot] Creating bot...');
  console.log(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);
  console.log('====================================');

  try {

    bot = mineflayer.createBot({
      host: config.server.ip,
      port: config.server.port,
      username: config.bot.username,
      auth: config.bot.auth,
      version: config.server.version,
      connectTimeout: 60000,
      checkTimeoutInterval: 120000
    });

    // ==================================================
    // LOGIN
    // ==================================================

    bot.on('login', () => {
      console.log('[Bot] Login successful');
    });

    bot.on('inject_allowed', () => {
      console.log('[Bot] INJECTION OK');
    });

    // ==================================================
    // SPAWN TIMEOUT SAFE
    // ==================================================

    const spawnTimeout = setTimeout(() => {
      if (!botConnected) {
        console.log('[Bot] Spawn timeout');
        scheduleReconnect('spawn-timeout');
      }
    }, 180000);

    // ==================================================
    // SPAWN OK
    // ==================================================

    bot.once('spawn', () => {
      clearTimeout(spawnTimeout);

      botConnected = true;
      reconnecting = false;

      console.log('[Bot] Successfully connected');

      startAntiAfk();

      if (config.autoLogin.enabled && config.autoLogin.password) {
        setTimeout(() => {
          if (!bot) return;

          bot.chat(`/login ${config.autoLogin.password}`);
          console.log('[Auth] Login sent');
        }, 3000);
      }
    });

    // ==================================================
    // DISCONNECT
    // ==================================================

    bot.on('end', () => {
      console.log('[Bot] Connection ended');
      botConnected = false;
      scheduleReconnect('end');
    });

    bot.on('kicked', (reason) => {
      console.log('[Bot] Kicked:', reason);
      botConnected = false;
      scheduleReconnect('kicked');
    });

    // ==================================================
    // ERROR FIX (IMPORTANT ATERNOS)
    // ==================================================

    bot.on('error', (err) => {
      console.log(`[Bot] Error: ${err.code || err.message}`);

      botConnected = false;

      if (err.code === 'ETIMEDOUT') {
        console.log('[Bot] Timeout → retry slower');
        setTimeout(() => scheduleReconnect('etimedout'), 10000);
      }

      else if (err.code === 'ECONNRESET') {
        console.log('[Bot] Reset → retry slower');
        setTimeout(() => scheduleReconnect('econnreset'), 15000);
      }

      else {
        scheduleReconnect('error');
      }
    });

  } catch (err) {
    console.log(`[Bot] Failed to create bot: ${err.message}`);
    scheduleReconnect('create-failed');
  }
}

// ======================================================
// STARTUP
// ======================================================

console.log('====================================');
console.log(' Minecraft AFK Bot Stable Edition');
console.log('====================================');

console.log('[Bot] Starting in 60 seconds...');

setTimeout(() => {
  createBot();
}, 60000);
