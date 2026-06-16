require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- CONFIG ----------
const PORT = process.env.PORT || 8080;
const DB_PATH = path.join(__dirname, 'db.json');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MERCHANT_PHONE = process.env.MERCHANT_PHONE;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim()));

// ---------- DATABASE ----------
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ 
      users: {},
      pendingDeposits: [],
      completedDeposits: []
    }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH));
}
function saveDB() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
let db = loadDB();

function getUser(telegramId) {
  if (!db.users[telegramId]) {
    db.users[telegramId] = { 
      balance: 0,
      totalBets: 0,
      totalDeposits: 0,
      createdAt: new Date().toISOString()
    };
    saveDB();
  }
  return db.users[telegramId];
}

function isAdmin(chatId) {
  return ADMIN_IDS.includes(chatId);
}

// ---------- TELEGRAM BOT ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ---------- EXPRESS ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, './')));

// ---------- API ENDPOINTS ----------

// Get pending deposits (for admin panel)
app.get('/api/pending', (req, res) => {
  const adminId = parseInt(req.query.adminId);
  if (!isAdmin(adminId)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  res.json(db.pendingDeposits.filter(d => d.status === 'pending'));
});

// Get user balance
app.get('/api/balance', (req, res) => {
  const telegramId = parseInt(req.query.userId);
  const user = getUser(telegramId);
  res.json({ balance: user.balance });
});

// Verify a deposit (admin only)
app.post('/api/verify', (req, res) => {
  const { adminId, depositId, action } = req.body;
  
  if (!isAdmin(adminId)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  const depositIndex = db.pendingDeposits.findIndex(d => d.id === depositId);
  if (depositIndex === -1) {
    return res.status(404).json({ error: 'Deposit not found' });
  }
  
  const deposit = db.pendingDeposits[depositIndex];
  
  if (action === 'approve') {
    const user = getUser(deposit.telegramId);
    user.balance += deposit.amount;
    user.totalDeposits += deposit.amount;
    
    db.completedDeposits.push({
      ...deposit,
      status: 'approved',
      verifiedBy: adminId,
      verifiedAt: new Date().toISOString()
    });
    
    bot.sendMessage(deposit.telegramId,
      `✅ *Deposit Approved!*\n\n` +
      `💰 Amount: ${deposit.amount} ETB\n` +
      `📊 New Balance: ${user.balance.toFixed(2)} ETB\n\n` +
      `🎮 Start playing with /bet`
    );
    
    db.pendingDeposits.splice(depositIndex, 1);
    saveDB();
    
    res.json({ success: true, balance: user.balance });
  } else if (action === 'reject') {
    db.completedDeposits.push({
      ...deposit,
      status: 'rejected',
      verifiedBy: adminId,
      verifiedAt: new Date().toISOString()
    });
    
    bot.sendMessage(deposit.telegramId,
      `❌ *Deposit Rejected*\n\n` +
      `Please send a clear screenshot of the payment.\n` +
      `Amount: ${deposit.amount} ETB`
    );
    
    db.pendingDeposits.splice(depositIndex, 1);
    saveDB();
    
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Invalid action' });
  }
});

// ---------- BOT COMMANDS ----------

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const user = getUser(chatId);
  const isAdminUser = isAdmin(chatId);
  
  let message = 
    `✈️ *Welcome to Ethiobet!*\n\n` +
    `💰 Balance: ${user.balance.toFixed(2)} ETB\n` +
    `🏦 Merchant: ${MERCHANT_PHONE}\n\n` +
    `📋 *Commands:*\n` +
    `/balance - Check balance\n` +
    `/deposit <amount> - Request deposit\n` +
    `/bet <amount> - Place bet\n` +
    `/cashout - Cash out during flight\n` +
    `/history - View history\n` +
    `/help - Show this message\n\n` +
    `📸 *To deposit:*\n` +
    `1. Send ${MERCHANT_PHONE} via Telebirr\n` +
    `2. Send the screenshot here\n` +
    `3. Wait for admin verification`;
  
  if (isAdminUser) {
    message += `\n\n🔑 *You are an admin!* Open the Mini App to manage deposits.`;
  }
  
  bot.sendMessage(chatId, message);
});

bot.onText(/\/balance/, (msg) => {
  const chatId = msg.chat.id;
  const user = getUser(chatId);
  bot.sendMessage(chatId, `💰 *Balance:* ${user.balance.toFixed(2)} ETB`);
});

bot.onText(/\/deposit (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const amount = parseFloat(match[1]);
  
  if (isNaN(amount) || amount < 1) {
    return bot.sendMessage(chatId, '⚠️ Enter a valid amount (min 1 ETB).');
  }
  
  const depositId = `DEP_${Date.now()}_${chatId}`;
  
  db.pendingDeposits.push({
    id: depositId,
    telegramId: chatId,
    amount: amount,
    status: 'pending',
    createdAt: new Date().toISOString()
  });
  saveDB();
  
  bot.sendMessage(chatId,
    `💳 *Deposit Request Created*\n\n` +
    `💰 Amount: ${amount} ETB\n` +
    `🏦 Send to: ${MERCHANT_PHONE}\n` +
    `🆔 Reference: ${depositId}\n\n` +
    `📸 *Instructions:*\n` +
    `1. Open Telebirr\n` +
    `2. Send ${amount} ETB to ${MERCHANT_PHONE}\n` +
    `3. Take a screenshot of the confirmation\n` +
    `4. Send the screenshot here\n\n` +
    `⏳ Your deposit will be verified manually.`
  );
});

bot.on('photo', (msg) => {
  const chatId = msg.chat.id;
  
  const pending = db.pendingDeposits.filter(d => d.telegramId === chatId && d.status === 'pending');
  if (pending.length === 0) {
    return bot.sendMessage(chatId, 
      '📸 No pending deposit found. Use /deposit <amount> first.'
    );
  }
  
  const photo = msg.photo[msg.photo.length - 1];
  const fileId = photo.file_id;
  
  const adminMessage = 
    `📸 *New Deposit Screenshot*\n\n` +
    `👤 User: ${msg.from.first_name} (${chatId})\n` +
    `💰 Amount: ${pending[0].amount} ETB\n` +
    `🆔 Ref: ${pending[0].id}`;

  ADMIN_IDS.forEach(adminId => {
    bot.sendPhoto(adminId, fileId, {
      caption: adminMessage,
      parse_mode: 'Markdown'
    });
  });
  
  bot.sendMessage(chatId, 
    `✅ Screenshot received!\n` +
    `⏳ Admin will verify shortly.`
  );
});

bot.onText(/\/history/, (msg) => {
  const chatId = msg.chat.id;
  const deposits = db.completedDeposits.filter(d => d.telegramId === chatId);
  
  if (deposits.length === 0) {
    return bot.sendMessage(chatId, '📭 No deposit history.');
  }
  
  let text = '📊 *Deposit History*\n\n';
  deposits.slice(-10).reverse().forEach(d => {
    const status = d.status === 'approved' ? '✅' : '❌';
    text += `${status} ${d.amount} ETB - ${new Date(d.createdAt).toLocaleDateString()}\n`;
  });
  
  bot.sendMessage(chatId, text);
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const isAdminUser = isAdmin(chatId);
  
  let message = 
    `✈️ *Ethiobet Commands*\n\n` +
    `/balance - Check balance\n` +
    `/deposit <amount> - Request deposit\n` +
    `/bet <amount> - Place a bet\n` +
    `/cashout - Cash out during flight\n` +
    `/history - View deposit history\n` +
    `/help - Show this message\n\n` +
    `🏦 *Send Telebirr to:* ${MERCHANT_PHONE}`;
  
  if (isAdminUser) {
    message += `\n\n🔑 *Admin:* Open the Mini App to manage deposits.`;
  }
  
  bot.sendMessage(chatId, message);
});

// ---------- WEBSOCKET GAME ENGINE ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let round = {
  status: 'waiting',
  multiplier: 1.00,
  crashPoint: 1.01,
  bets: {},
  timer: null,
};

function generateCrashPoint() {
  let r = Math.random();
  let crash = 1.01 + (1.0 / (1.0 - r * 0.98)) * 0.5;
  return Math.min(50, Math.max(1.01, parseFloat(crash.toFixed(2))));
}

function broadcast(data) {
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data));
  });
}

function startNewRound() {
  if (round.timer) clearInterval(round.timer);
  round.crashPoint = generateCrashPoint();
  round.status = 'flying';
  round.multiplier = 1.00;
  round.bets = {};
  broadcast({ type: 'round_started' });

  let start = Date.now();
  round.timer = setInterval(() => {
    let current = 1.00 + ((Date.now() - start) / 1000) * 1.2;
    if (current >= round.crashPoint) {
      clearInterval(round.timer);
      round.status = 'crashed';
      round.multiplier = round.crashPoint;
      broadcast({ type: 'game_crashed', multiplier: round.crashPoint });
      round.bets = {};
      setTimeout(startNewRound, 3000);
    } else {
      round.multiplier = parseFloat(current.toFixed(2));
      broadcast({ type: 'multiplier_update', multiplier: round.multiplier });
    }
  }, 100);
}

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const telegramId = urlParams.get('userId');
  if (!telegramId) {
    ws.close();
    return;
  }
  ws.telegramId = telegramId;
  ws.socketId = crypto.randomUUID();

  const user = getUser(telegramId);
  ws.send(JSON.stringify({ type: 'init', balance: user.balance, telegramId }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      const user = getUser(ws.telegramId);
      if (!user) return;

      switch (data.type) {
        case 'place_bet': {
          const amount = parseFloat(data.amount);
          if (isNaN(amount) || amount <= 0) {
            return ws.send(JSON.stringify({ type: 'error', message: 'Invalid bet' }));
          }
          if (round.status !== 'flying' && round.status !== 'waiting') {
            return ws.send(JSON.stringify({ type: 'error', message: 'Round not active' }));
          }
          if (round.bets[ws.socketId]) {
            return ws.send(JSON.stringify({ type: 'error', message: 'Bet already placed' }));
          }
          if (user.balance < amount) {
            return ws.send(JSON.stringify({ type: 'error', message: 'Insufficient balance' }));
          }
          user.balance -= amount;
          saveDB();
          round.bets[ws.socketId] = { telegramId: ws.telegramId, amount };
          ws.send(JSON.stringify({ type: 'bet_placed', balance: user.balance }));
          break;
        }
        case 'cash_out': {
          if (round.status !== 'flying') {
            return ws.send(JSON.stringify({ type: 'error', message: 'Not flying' }));
          }
          const bet = round.bets[ws.socketId];
          if (!bet) {
            return ws.send(JSON.stringify({ type: 'error', message: 'No active bet' }));
          }
          const winAmount = bet.amount * round.multiplier;
          user.balance += winAmount;
          saveDB();
          delete round.bets[ws.socketId];
          ws.send(JSON.stringify({
            type: 'cash_out_success',
            multiplier: round.multiplier,
            winAmount,
            balance: user.balance
          }));
          broadcast({ type: 'user_cashed_out', telegramId: ws.telegramId, multiplier: round.multiplier });
          break;
        }
        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown command' }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }
  });

  ws.on('close', () => {
    if (round.bets[ws.socketId]) {
      delete round.bets[ws.socketId];
    }
  });
});

setTimeout(startNewRound, 1000);

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🤖 Bot is active`);
  console.log(`🏦 Merchant: ${MERCHANT_PHONE}`);
  console.log(`👑 Admins: ${ADMIN_IDS.join(', ')}`);
});
