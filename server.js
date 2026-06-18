require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- CONFIG ----------
const PORT = process.env.PORT || 8080;
const DB_PATH = path.join(__dirname, 'db.json');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MERCHANT_PHONE = process.env.MERCHANT_PHONE || '0934600018';
const ADMIN_IDS = (process.env.ADMIN_IDS || '7154361039').split(',').map(id => parseInt(id.trim()));
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key_change_me';

console.log('🚀 Starting Ethiobet Platform...');
console.log('🤖 Bot: @Ethiobet1_bot');
console.log('📱 Merchant:', MERCHANT_PHONE);
console.log('👑 Admins:', ADMIN_IDS);

// ---------- EXPRESS + CORS ----------
const app = express();
app.use(cors({
  origin: [FRONTEND_URL, 'http://localhost:3000', 'http://localhost:8080', 'https://ethiobet.vercel.app', 'https://ethiobet.onrender.com'],
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------- DATABASE ----------
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ 
      users: [],
      pendingDeposits: [],
      completedDeposits: [],
      chatMessages: []
    }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH));
}
function saveDB() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
let db = loadDB();

function findUser(phone) {
  return db.users.find(u => u.phone === phone);
}

function getUser(id) {
  return db.users.find(u => u.id === id);
}

function isAdmin(id) {
  return ADMIN_IDS.includes(id);
}

// ---------- AUTH ENDPOINTS ----------
app.post('/api/register', async (req, res) => {
  const { phone, password, name } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
  if (findUser(phone)) return res.status(400).json({ error: 'User already exists' });
  
  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = {
    id: Date.now(),
    phone,
    name: name || 'User',
    password: hashedPassword,
    balance: 0,
    totalDeposits: 0,
    totalBets: 0,
    createdAt: new Date().toISOString()
  };
  db.users.push(newUser);
  saveDB();
  const token = jwt.sign({ id: newUser.id, phone }, JWT_SECRET);
  res.json({ success: true, token, user: { id: newUser.id, phone, name: newUser.name, balance: newUser.balance } });
});

app.post('/api/login', async (req, res) => {
  const { phone, password } = req.body;
  const user = findUser(phone);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, phone }, JWT_SECRET);
  res.json({ success: true, token, user: { id: user.id, phone, name: user.name, balance: user.balance } });
});

app.get('/api/profile', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, phone: user.phone, name: user.name, balance: user.balance });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ---------- DEPOSIT ENDPOINTS ----------
app.get('/api/pending', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!isAdmin(decoded.id)) return res.status(403).json({ error: 'Unauthorized' });
    res.json(db.pendingDeposits.filter(d => d.status === 'pending'));
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.post('/api/verify', async (req, res) => {
  const { adminId, depositId, action } = req.body;
  if (!isAdmin(adminId)) return res.status(403).json({ error: 'Unauthorized' });
  const depositIndex = db.pendingDeposits.findIndex(d => d.id === depositId);
  if (depositIndex === -1) return res.status(404).json({ error: 'Deposit not found' });
  const deposit = db.pendingDeposits[depositIndex];
  
  if (action === 'approve') {
    const user = db.users.find(u => u.id === deposit.telegramId || u.phone === deposit.telegramId.toString());
    if (user) {
      user.balance += deposit.amount;
      user.totalDeposits += deposit.amount;
    }
    db.completedDeposits.push({ ...deposit, status: 'approved', verifiedBy: adminId, verifiedAt: new Date().toISOString() });
    if (user) {
      try { await bot.sendMessage(deposit.telegramId, `✅ Deposit Approved!\n💰 ${deposit.amount} ETB\n📊 New Balance: ${user.balance.toFixed(2)} ETB`); } catch(e) {}
    }
    db.pendingDeposits.splice(depositIndex, 1);
    saveDB();
    res.json({ success: true, balance: user ? user.balance : 0 });
  } else if (action === 'reject') {
    db.completedDeposits.push({ ...deposit, status: 'rejected', verifiedBy: adminId, verifiedAt: new Date().toISOString() });
    try { await bot.sendMessage(deposit.telegramId, `❌ Deposit Rejected\nPlease send a clear screenshot.`); } catch(e) {}
    db.pendingDeposits.splice(depositIndex, 1);
    saveDB();
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Invalid action' });
  }
});

// ---------- TELEGRAM BOT ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `✈️ *Welcome to Ethiobet!*\n\n` +
    `🎮 Play crash games, slots, and more!\n` +
    `💰 Deposit via Telebirr\n` +
    `✅ Auto-verification\n\n` +
    `Tap the button below to start playing!`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎮 Play Now', web_app: { url: FRONTEND_URL } }],
          [{ text: '💰 Deposit', callback_data: 'deposit' }],
          [{ text: '📊 Balance', callback_data: 'balance' }]
        ]
      }
    }
  );
});

bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  bot.answerCallbackQuery(query.id);
  switch(query.data) {
    case 'deposit':
      bot.sendMessage(chatId, `💳 Deposit Instructions\n\n1️⃣ Send to: ${MERCHANT_PHONE}\n2️⃣ Take a screenshot\n3️⃣ Send it here\n4️⃣ Auto-verified instantly!`);
      break;
    case 'balance':
      const user = db.users.find(u => u.id === chatId || u.phone === chatId.toString());
      bot.sendMessage(chatId, user ? `💰 Balance: ${user.balance.toFixed(2)} ETB` : '📊 Please login first.');
      break;
  }
});

// Auto-verification
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const pending = db.pendingDeposits.filter(d => d.telegramId === chatId && d.status === 'pending');
  if (pending.length === 0) {
    return bot.sendMessage(chatId, '📸 No pending deposit. Use the Deposit button first.');
  }
  const photo = msg.photo[msg.photo.length - 1];
  const fileId = photo.file_id;
  const deposit = pending[0];
  const user = db.users.find(u => u.id === chatId || u.phone === chatId.toString());
  if (user) {
    user.balance += deposit.amount;
    user.totalDeposits += deposit.amount;
  }
  db.completedDeposits.push({ ...deposit, status: 'approved', verifiedBy: 'auto', verifiedAt: new Date().toISOString(), photoFileId: fileId });
  const idx = db.pendingDeposits.findIndex(d => d.id === deposit.id);
  if (idx !== -1) db.pendingDeposits.splice(idx, 1);
  saveDB();
  bot.sendMessage(chatId, `✅ Deposit Auto-Approved!\n💰 ${deposit.amount} ETB\n📊 New Balance: ${user ? user.balance.toFixed(2) : 'N/A'}`);
  ADMIN_IDS.forEach(adminId => {
    bot.sendPhoto(adminId, fileId, { caption: `📸 Auto-Verified Deposit\n👤 ${msg.from.first_name} (${chatId})\n💰 ${deposit.amount} ETB\n✅ Status: Auto-approved` });
  });
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
  const userId = urlParams.get('userId');
  if (!userId) { ws.close(); return; }
  ws.userId = userId;
  ws.socketId = crypto.randomUUID();
  const user = db.users.find(u => u.id === parseInt(userId) || u.phone === userId);
  const balance = user ? user.balance : 0;
  ws.send(JSON.stringify({ type: 'init', balance, userId }));

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      const user = db.users.find(u => u.id === parseInt(ws.userId) || u.phone === ws.userId);
      if (!user) { ws.send(JSON.stringify({ type: 'error', message: 'User not found' })); return; }
      switch (data.type) {
        case 'place_bet': {
          const amount = parseFloat(data.amount);
          if (isNaN(amount) || amount <= 0) return ws.send(JSON.stringify({ type: 'error', message: 'Invalid bet' }));
          if (round.status !== 'flying' && round.status !== 'waiting') return ws.send(JSON.stringify({ type: 'error', message: 'Round not active' }));
          if (round.bets[ws.socketId]) return ws.send(JSON.stringify({ type: 'error', message: 'Bet already placed' }));
          if (user.balance < amount) return ws.send(JSON.stringify({ type: 'error', message: 'Insufficient balance' }));
          user.balance -= amount;
          saveDB();
          round.bets[ws.socketId] = { userId: ws.userId, amount };
          ws.send(JSON.stringify({ type: 'bet_placed', balance: user.balance }));
          break;
        }
        case 'cash_out': {
          if (round.status !== 'flying') return ws.send(JSON.stringify({ type: 'error', message: 'Not flying' }));
          const bet = round.bets[ws.socketId];
          if (!bet) return ws.send(JSON.stringify({ type: 'error', message: 'No active bet' }));
          const winAmount = bet.amount * round.multiplier;
          user.balance += winAmount;
          saveDB();
          delete round.bets[ws.socketId];
          ws.send(JSON.stringify({ type: 'cash_out_success', multiplier: round.multiplier, winAmount, balance: user.balance }));
          broadcast({ type: 'user_cashed_out', userId: ws.userId, multiplier: round.multiplier });
          break;
        }
        default: ws.send(JSON.stringify({ type: 'error', message: 'Unknown command' }));
      }
    } catch (err) { ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' })); }
  });

  ws.on('close', () => {
    if (round.bets[ws.socketId]) delete round.bets[ws.socketId];
  });
});

setTimeout(startNewRound, 1000);

server.listen(PORT, () => {
  console.log(`🚀 Server running on ${BACKEND_URL}`);
  console.log(`🤖 Bot @Ethiobet1_bot is active`);
  console.log(`✅ Auto-Verification ENABLED`);
});
