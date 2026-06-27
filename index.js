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
// EXPRESS SERVER (RENDER)
// ======================================================

const app = express();

const PORT = process.env.PORT || 10000;

app.get('/', (_, res) => {
  res.send('Minecraft AFK Bot Online');
});

app.get('/health', (_, res) => {
  res.json({
    status: botConnected ? 'online' : 'offline'
  });
});

app.listen(PORT, () => {
  console.log(`[Server] HTTP server started on port ${PORT}`);
});

// ======================================================
// VARIABLES
// ======================================================

let bot = null;

let reconnectTimeout = null;

let antiAfkInterval = null;

let reconnecting = false;

let botConnected = false;

// ======================================================
// CLEANUP
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

    bot = null;
  }

  botConnected = false;
}

// ======================================================
// ANTI AFK
// ======================================================

function startAntiAfk() {

  if (!config.antiAfk.enabled) return;

  if (antiAfkInterval) {
    clearInterval(antiAfkInterval);
  }

  console.log('[Bot] Anti AFK started');

  antiAfkInterval = setInterval(() => {

    if (!bot || !bot.entity) return;

    const actions = [
      'jump',
      'forward',
      'left',
      'right'
    ];

    const action =
      actions[Math.floor(Math.random() * actions.length)];

    bot.setControlState(action, true);

    setTimeout(() => {

      if (!bot) return;

      bot.setControlState(action, false);

    }, 1000);

  }, config.antiAfk.delay);
}

// ======================================================
// RECONNECT
// ======================================================

function scheduleReconnect(reason = 'unknown') {

  if (!config.reconnect.enabled) return;

  if (reconnecting) {
    console.log('[Bot] Reconnect already in progress');
    return;
  }

  reconnecting = true;

  console.log(`[Bot] Reconnecting because: ${reason}`);

  cleanupBot();

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }

  let delay = config.reconnect.delay;

  if (reason === 'end' || reason === 'kicked' || reason === 'spawn-timeout') {
    delay = 3000;
  }

  reconnectTimeout = setTimeout(() => {

    reconnecting = false;
    createBot();

  }, delay);
}

// ======================================================
// CREATE BOT
// ======================================================

function createBot() {

  if (bot && !bot._client?.socket?.destroyed) {
  console.log('[Bot] Bot already exists');
  return;
}

  console.log('====================================');
  console.log('[Bot] Creating bot...');
  console.log(
    `[Bot] Connecting to ${config.server.ip}:${config.server.port}`
  );
  console.log('====================================');

  try {

    bot = mineflayer.createBot({

      host: config.server.ip,

      port: config.server.port,

      username: config.bot.username,

      auth: config.bot.auth,

      version: config.server.version,

      hideErrors: false,

      connectTimeout: 60000,

      checkTimeoutInterval: 120000
    });

    bot.on('login', () => {
  console.log('[Bot] LOGIN EVENT');
});

bot.on('inject_allowed', () => {
  console.log('[Bot] INJECTION OK');
});

    // ==================================================
    // LOGIN EVENT
    // ==================================================

    bot.on('login', () => {
      console.log('[Bot] Login successful');
    });

    // ==================================================
    // SPAWN TIMEOUT
    // ==================================================

    const spawnTimeout = setTimeout(() => {

  if (!botConnected) {
    console.log('[Bot] Spawn timeout');
    scheduleReconnect('spawn-timeout');
  }

}, 180000);

    // ==================================================
    // SPAWN
    // ==================================================

    bot.once('spawn', () => {

      clearTimeout(spawnTimeout);

      botConnected = true;

      reconnecting = false;

      console.log('[Bot] Successfully connected');

      startAntiAfk();

      // ==============================================
      // AUTO LOGIN
      // ==============================================

      if (
        config.autoLogin.enabled &&
        config.autoLogin.password
      ) {

        setTimeout(() => {

          if (!bot) return;

          bot.chat(`/login ${config.autoLogin.password}`);

          console.log('[Auth] Login command sent');

        }, 3000);
      }
    });

    // ==================================================
    // END
    // ==================================================

    bot.on('end', () => {

      console.log('[Bot] Connection ended');

      botConnected = false;

      scheduleReconnect('end');
    });

    // ==================================================
    // KICKED
    // ==================================================

    bot.on('kicked', (reason) => {

      console.log('[Bot] Kicked:', reason);

      botConnected = false;

      scheduleReconnect('kicked');
    });

    // ==================================================
    // ERROR
    // ==================================================

    bot.on('error', (err) => {

      console.log(
        `[Bot] Error: ${err.code || err.message}`
      );
    });

  } catch (err) {

    console.log(
      `[Bot] Failed to create bot: ${err.message}`
    );

    scheduleReconnect('create-failed');
  }
}

// ======================================================
// STARTUP
// ======================================================

console.log('====================================');
console.log(' Minecraft AFK Bot Stable Edition');
console.log('====================================');

console.log(
  '[Bot] Waiting 60 seconds before startup...'
);

// IMPORTANT POUR ATERNOS
// laisse le serveur finir de démarrer

setTimeout(() => {
  createBot();
}, 60000);
