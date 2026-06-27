'use strict';

// ============================================================
// Crash handlers — DOIT être en tout premier
// ============================================================
process.on('uncaughtException', (err) => {
  console.log('[CRASH] uncaughtException:', err.message);
  // On NE quitte PAS le process — on laisse le bot se reconnecter
});
process.on('unhandledRejection', (reason) => {
  console.log('[CRASH] unhandledRejection:', reason);
  // Pareil — on ne quitte pas
});

const mineflayer = require('mineflayer');
const express    = require('express');
const http       = require('http');
const https      = require('https');
const config     = require('./settings.json');

// ============================================================
// EXPRESS
// ============================================================
const app  = express();
const PORT = process.env.PORT || 10000;

const botState = {
  connected: false,
  attempts:  0,
  startTime: Date.now(),
};

app.get('/', (_, res) => {
  res.send(`
    <h2>Minecraft AFK Bot</h2>
    <p>Status : <b>${botState.connected ? '🟢 Online' : '🔴 Offline'}</b></p>
    <p>Tentatives : ${botState.attempts}</p>
    <p>Uptime : ${Math.floor((Date.now() - botState.startTime) / 1000)}s</p>
  `);
});
app.get('/health', (_, res) => res.json({ status: botState.connected ? 'online' : 'offline', attempts: botState.attempts }));
app.get('/ping',   (_, res) => res.send('pong'));

app.listen(PORT, () => console.log(`[Server] HTTP server started on port ${PORT}`));

// ============================================================
// SELF-PING
// ============================================================
setInterval(() => {
  const url      = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const protocol = url.startsWith('https') ? https : http;
  protocol.get(`${url}/ping`, () => {}).on('error', () => {});
}, 10 * 60 * 1000);

// ============================================================
// VARIABLES
// ============================================================
let bot            = null;
let reconnecting   = false;
let reconnectTimer = null;
let afkInterval    = null;
let chatInterval   = null;

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
// RECONNEXION — avec délai exponentiel et pause longue
// si trop d'échecs
// ============================================================
function scheduleReconnect(reason) {
  if (reconnecting) return;
  reconnecting = true;
  cleanup();

  // Si plus de 10 échecs consécutifs → pause de 10 minutes
  // pour laisser Aternos débloquer l'IP
  if (botState.attempts >= 10) {
    console.log('[Bot] Trop d\'échecs — pause de 10 minutes avant de réessayer');
    botState.attempts = 0;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnecting = false;
      createBot();
    }, 10 * 60 * 1000);
    return;
  }

  const baseDelay = 20000;
  const maxDelay  = 120000;
  const delay     = Math.min(baseDelay + botState.attempts * 10000, maxDelay);

  botState.attempts++;
  console.log(`[Bot] Reconnexion dans ${Math.round(delay / 1000)}s — raison: ${reason} (tentative #${botState.attempts})`);

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
    try {
      bot.setControlState(action, true);
      setTimeout(() => {
        if (bot) bot.setControlState(action, false);
      }, 800 + Math.random() * 400);

      bot.look(
        (Math.random() - 0.5) * Math.PI * 2,
        (Math.random() - 0.5) * Math.PI * 0.5,
        false
      );
    } catch (_) {}

  }, 15000 + Math.random() * 5000);

  console.log('[Bot] Anti-AFK démarré');
}

// ============================================================
// CHAT PÉRIODIQUE
// ============================================================
function startChatMessages() {
  const cfg = config.utils && config.utils['chat-messages'];
  if (!cfg || !cfg.enabled || !cfg.repeat) return;
  if (chatInterval) clearInterval(chatInterval);

  const messages = cfg.messages || [];
  if (!messages.length) return;

  let i = 0;
  chatInterval = setInterval(() => {
    if (!bot || !botState.connected) return;
    try { bot.chat(messages[i % messages.length]); } catch (_) {}
    i++;
  }, (cfg['repeat-delay'] || 300) * 1000);
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
    try { bot.chat(`/register ${pwd} ${pwd}`); } catch (_) {}
    setTimeout(() => {
      if (!bot) return;
      try {
        bot.chat(`/login ${pwd}`);
        console.log('[Auth] Commandes login envoyées');
      } catch (_) {}
    }, 2000);
  }, 3000);
}

// ============================================================
// CRÉATION DU BOT
// ============================================================
function createBot() {
  if (bot) return;

  console.log('==========================================');
  console.log(' Minecraft AFK Bot — Stable Edition');
  console.log(`[Bot] Connexion à ${config.server.ip}:${config.server.port}`);
  console.log('==========================================');

  try {
    bot = mineflayer.createBot({
      host:     config.server.ip,
      port:     config.server.port,
      username: config['bot-account'].username,
      auth:     config['bot-account'].type || 'offline',
      version:  config.server.version,

      connectTimeout:       60000,  // 60s pour établir TCP
      checkTimeoutInterval: 30000,  // répond aux keepalive toutes les 30s
      hideErrors: true,             // mineflayer ne lève plus d'erreurs non catchées
    });

  } catch (err) {
    console.log(`[Bot] Échec création: ${err.message}`);
    scheduleReconnect('create-failed');
    return;
  }

  // Timeout spawn 3 minutes
  const spawnTimeout = setTimeout(() => {
    if (!botState.connected) {
      console.log('[Bot] Timeout spawn (3min)');
      scheduleReconnect('spawn-timeout');
    }
  }, 180000);

  bot.once('spawn', () => {
    clearTimeout(spawnTimeout);
    botState.connected = true;
    botState.attempts  = 0;
    reconnecting       = false;
    console.log('[Bot] ✅ Connecté avec succès !');
    sendLogin();
    startAntiAfk();
    startChatMessages();
  });

  bot.on('end', (reason) => {
    clearTimeout(spawnTimeout);
    console.log(`[Bot] Déconnecté — ${reason || 'inconnu'}`);
    scheduleReconnect('end');
  });

  bot.on('kicked', (reason) => {
    clearTimeout(spawnTimeout);
    let msg = reason;
    try { msg = JSON.parse(reason).text || reason; } catch (_) {}
    console.log(`[Bot] Kick: ${msg}`);
    scheduleReconnect('kicked');
  });

  bot.on('error', (err) => {
    // On log sans propager l'erreur
    console.log(`[Bot] Erreur réseau: ${err.code || err.message}`);
  });

  if (config.utils && config.utils['chat-log']) {
    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      console.log(`[Chat] <${username}> ${message}`);
    });
  }
}

// ============================================================
// DÉMARRAGE — 30s d'attente pour Aternos
// ============================================================
console.log('==========================================');
console.log(' Minecraft AFK Bot — Stable Edition');
console.log(`[Bot] Serveur: ${config.server.ip}:${config.server.port}`);
console.log('[Bot] Attente 30s pour le chargement Aternos...');
console.log('==========================================');

setTimeout(createBot, 30000);
