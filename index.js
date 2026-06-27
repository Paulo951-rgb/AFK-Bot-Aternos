'use strict';

// ============================================================
// Crash handlers — empêche Render de killer le process
// ============================================================
process.on('uncaughtException', (err) => {
  console.log('[CRASH] uncaughtException:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.log('[CRASH] unhandledRejection:', reason);
});

const mineflayer = require('mineflayer');
const express    = require('express');
const http       = require('http');
const https      = require('https');
const config     = require('./settings.json');

// ============================================================
// EXPRESS — health check pour Render
// ============================================================
const app  = express();
const PORT = process.env.PORT || 10000;

app.get('/', (_, res) => {
  res.send(`
    <h2>Minecraft AFK Bot</h2>
    <p>Status : <b>${botState.connected ? '🟢 Online' : '🔴 Offline'}</b></p>
    <p>Reconnections : ${botState.attempts}</p>
    <p>Uptime : ${Math.floor((Date.now() - botState.startTime) / 1000)}s</p>
  `);
});

app.get('/health', (_, res) => {
  res.json({
    status:   botState.connected ? 'online' : 'offline',
    attempts: botState.attempts,
    uptime:   Math.floor((Date.now() - botState.startTime) / 1000),
  });
});

app.get('/ping', (_, res) => res.send('pong'));

app.listen(PORT, () => {
  console.log(`[Server] HTTP server started on port ${PORT}`);
});

// ============================================================
// SELF-PING — évite que Render endorme le service gratuit
// ============================================================
function startSelfPing() {
  const INTERVAL = 10 * 60 * 1000;
  setInterval(() => {
    const url      = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(`${url}/ping`, () => {}).on('error', () => {});
  }, INTERVAL);
}
startSelfPing();

// ============================================================
// ÉTAT GLOBAL
// ============================================================
let bot            = null;
let reconnecting   = false;
let reconnectTimer = null;
let afkInterval    = null;
let chatInterval   = null;

const botState = {
  connected: false,
  attempts:  0,
  startTime: Date.now(),
};

// ============================================================
// NETTOYAGE
// ============================================================
function cleanup() {
  if (afkInterval)  { clearInterval(afkInterval);  afkInterval  = null; }
  if (chatInterval) { clearInterval(chatInterval); chatInterval = null; }

  if (bot) {
    try { bot.removeAllListeners(); } catch (_) {}
    try { bot.end(); }               catch (_) {}
    bot = null;
  }

  botState.connected = false;
  reconnecting       = false;
}

// ============================================================
// RECONNEXION
// ============================================================
function scheduleReconnect(reason) {
  if (reconnecting) return;
  reconnecting = true;

  cleanup();

  const baseDelay = config.utils['auto-reconnect-delay'] || 15000;
  const maxDelay  = config.utils['max-reconnect-delay']  || 120000;
  const delay     = Math.min(baseDelay + botState.attempts * 5000, maxDelay);

  botState.attempts++;
  console.log(`[Bot] Reconnecting in ${Math.round(delay / 1000)}s — reason: ${reason} (attempt #${botState.attempts})`);

  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnecting = false;
    createBot();
  }, delay);
}

// ============================================================
// ANTI-AFK
// ============================================================
function startAntiAfk() {
  if (afkInterval) clearInterval(afkInterval);

  const actions = ['jump', 'forward', 'left', 'right', 'back'];

  afkInterval = setInterval(() => {
    if (!bot || !bot.entity) return;

    const action = actions[Math.floor(Math.random() * actions.length)];
    bot.setControlState(action, true);
    setTimeout(() => {
      if (bot) bot.setControlState(action, false);
    }, 800 + Math.random() * 400);

    const yaw   = (Math.random() - 0.5) * Math.PI * 2;
    const pitch = (Math.random() - 0.5) * Math.PI * 0.5;
    bot.look(yaw, pitch, false);

  }, 15000 + Math.random() * 5000);

  console.log('[Bot] Anti-AFK started');
}

// ============================================================
// CHAT PÉRIODIQUE
// ============================================================
function startChatMessages() {
  const cfg = config.utils['chat-messages'];
  if (!cfg || !cfg.enabled || !cfg.repeat) return;
  if (chatInterval) clearInterval(chatInterval);

  const messages = cfg.messages || [];
  if (messages.length === 0) return;

  let i = 0;
  const delay = (cfg['repeat-delay'] || 300) * 1000;

  chatInterval = setInterval(() => {
    if (!bot || !botState.connected) return;
    bot.chat(messages[i % messages.length]);
    i++;
  }, delay);
}

// ============================================================
// AUTO-LOGIN
// ============================================================
function sendLogin() {
  const authCfg = config.utils && config.utils['auto-auth'];
  if (!authCfg || !authCfg.enabled) return;

  const pwd = authCfg.password;
  setTimeout(() => {
    if (!bot) return;
    bot.chat(`/register ${pwd} ${pwd}`);
    setTimeout(() => {
      if (!bot) return;
      bot.chat(`/login ${pwd}`);
      console.log('[Auth] Login commands sent');
    }, 1500);
  }, 2000);
}

// ============================================================
// CRÉATION DU BOT
// ============================================================
function createBot() {
  if (bot) {
    console.log('[Bot] Instance already exists, skipping');
    return;
  }

  console.log('==========================================');
  console.log(' Minecraft AFK Bot — Stable Edition');
  console.log(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);
  console.log('==========================================');

  try {
    bot = mineflayer.createBot({
      host:     config.server.ip,
      port:     config.server.port,
      username: config['bot-account'].username,
      auth:     config['bot-account'].type || 'offline',
      version:  config.server.version,

      connectTimeout:       90000,  // 90s pour établir la connexion TCP
      checkTimeoutInterval: 30000,  // 30s — répond aux keepalive du serveur
      hideErrors: false,
    });

  } catch (err) {
    console.log(`[Bot] Failed to create: ${err.message}`);
    scheduleReconnect('create-failed');
    return;
  }

  // Timeout de spawn : si pas de spawn en 3 min → reconnect
  const spawnTimeout = setTimeout(() => {
    if (!botState.connected) {
      console.log('[Bot] Spawn timeout (3min) — reconnecting');
      scheduleReconnect('spawn-timeout');
    }
  }, 180000);

  // SPAWN
  bot.once('spawn', () => {
    clearTimeout(spawnTimeout);
    botState.connected = true;
    botState.attempts  = 0;
    reconnecting       = false;

    console.log('[Bot] ✅ Successfully spawned!');

    sendLogin();
    startAntiAfk();
    startChatMessages();
  });

  // DÉCONNEXION
  bot.on('end', (reason) => {
    console.log(`[Bot] Disconnected — ${reason || 'no reason'}`);
    clearTimeout(spawnTimeout);
    if (config.utils['auto-reconnect'] !== false) {
      scheduleReconnect('end');
    }
  });

  // KICK
  bot.on('kicked', (reason) => {
    let msg = reason;
    try { msg = JSON.stringify(JSON.parse(reason)); } catch (_) {}
    console.log(`[Bot] Kicked: ${msg}`);
    clearTimeout(spawnTimeout);
    scheduleReconnect('kicked');
  });

  // ERREUR réseau
  bot.on('error', (err) => {
    console.log(`[Bot] Network error: ${err.code || err.message}`);
  });

  // CHAT log
  if (config.utils && config.utils['chat-log']) {
    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      console.log(`[Chat] <${username}> ${message}`);
    });
  }
}

// ============================================================
// DÉMARRAGE
// ============================================================
console.log('==========================================');
console.log(' Minecraft AFK Bot — Stable Edition');
console.log(`[Bot] Server: ${config.server.ip}:${config.server.port}`);
console.log('[Bot] Waiting 30s for Aternos to load...');
console.log('==========================================');

setTimeout(() => {
  createBot();
}, 30000);
