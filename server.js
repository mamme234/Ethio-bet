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
const FRONTEND_PATH = path.join(__dirname, 'src', 'ethiobet-frontend');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MERCHANT_PHONE = process.env.MERCHANT_PHONE || '0934600018';
const ADMIN_IDS = (process.env.ADMIN_IDS || '7154361039').split(',').map(id => parseInt(id.trim()));
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
const FRONTEND_URL = process.env.FRONTEND_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'mamme dev';

console.log('🚀 Starting Ethiobet Platform...');
console.log('🤖 Bot: @Ethiobet1_bot');
console.log('📱 Merchant:', MERCHANT_PHONE);
console.log('👑 Admins:', ADMIN_IDS);
console.log('🔗 Backend URL:', BACKEND_URL);
console.log('📁 Frontend Path:', FRONTEND_PATH);

// ---------- EXPRESS + CORS ----------
const app = express();

// Allow all origins for testing - PRODUCTION: restrict to specific domains
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- SERVE FRONTEND FROM src/ethiobet-frontend ----------
// Check if frontend folder exists
if (fs.existsSync(FRONTEND_PATH)) {
  console.log('✅ Frontend folder found at:', FRONTEND_PATH);
  app.use(express.static(FRONTEND_PATH));
} else {
  console.log('❌ Frontend folder NOT found at:', FRONTEND_PATH);
  console.log('📁 Creating frontend folder...');
  fs.mkdirSync(FRONTEND_PATH, { recursive: true });
}

// Serve index.html for the root route
app.get('/', (req, res) => {
  const indexPath = path.join(FRONTEND_PATH, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.send(`
      <h1>🚀 Ethiobet Backend Running</h1>
      <p>Frontend files not found. Please add your HTML files to:</p>
      <code>${FRONTEND_PATH}</code>
      <p>Current directory: ${__dirname}</p>
    `);
  }
});

// Serve all HTML files from frontend folder
app.get('/:page.html', (req, res) => {
  const page = req.params.page;
  const filePath = path.join(FRONTEND_PATH, `${page}.html`);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send(`Page "${page}.html" not found in ${FRONTEND_PATH}`);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    frontendPath: FRONTEND_PATH,
    frontendExists: fs.existsSync(FRONTEND_PATH)
  });
});

// ---------- DATABASE ----------
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ 
      users: [],
      pendingDeposits: [],
      completedDeposits: [],
      chatMessages: [],
      sportsBets: [],
      matches: []
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
  console.log('📝 Register attempt:', { phone, name });
  
  if (!phone || !password) {
    return res.status(400).json({ error: 'Phone and password required' });
  }
  
  if (findUser(phone)) {
    return res.status(400).json({ error: 'User already exists' });
  }
  
  try {
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
    console.log('✅ User registered:', phone);
    
    const token = jwt.sign({ id: newUser.id, phone }, JWT_SECRET);
    res.json({ 
      success: true, 
      token, 
      user: { 
        id: newUser.id, 
        phone, 
        name: newUser.name, 
        balance: newUser.balance 
      } 
    });
  } catch (err) {
    console.error('❌ Registration error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { phone, password } = req.body;
  console.log('🔐 Login attempt:', phone);
  
  const user = findUser(phone);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  try {
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    console.log('✅ Login successful:', phone);
    
    const token = jwt.sign({ id: user.id, phone }, JWT_SECRET);
    res.json({ 
      success: true, 
      token, 
      user: { 
        id: user.id, 
        phone: user.phone, 
        name: user.name, 
        balance: user.balance 
      } 
    });
  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/profile', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ 
      id: user.id, 
      phone: user.phone, 
      name: user.name, 
      balance: user.balance 
    });
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
      try { 
        await bot.sendMessage(deposit.telegramId, 
          `✅ *Deposit Approved!*\n\n💰 Amount: ${deposit.amount} ETB\n📊 New Balance: ${user.balance.toFixed(2)} ETB`,
          { parse_mode: 'Markdown' }
        ); 
      } catch(e) {}
    }
    db.pendingDeposits.splice(depositIndex, 1);
    saveDB();
    res.json({ success: true, balance: user ? user.balance : 0 });
  } else if (action === 'reject') {
    db.completedDeposits.push({ ...deposit, status: 'rejected', verifiedBy: adminId, verifiedAt: new Date().toISOString() });
    try { 
      await bot.sendMessage(deposit.telegramId, 
        `❌ *Deposit Rejected*\n\nPlease send a clear screenshot.`
      ); 
    } catch(e) {}
    db.pendingDeposits.splice(depositIndex, 1);
    saveDB();
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Invalid action' });
  }
});

// ---------- SPORTS BETTING ENDPOINTS ----------
app.get('/api/matches', (req, res) => {
  const now = Date.now();
  if (db.matches.length === 0) {
    const dummyMatches = [
      { id: 'm1', home: 'Brazil', away: 'Argentina', homeOdds: 2.10, drawOdds: 3.20, awayOdds: 3.50, startTime: now + 3600000, status: 'upcoming' },
      { id: 'm2', home: 'France', away: 'Germany', homeOdds: 2.40, drawOdds: 3.00, awayOdds: 2.90, startTime: now + 7200000, status: 'upcoming' },
      { id: 'm3', home: 'England', away: 'Spain', homeOdds: 2.60, drawOdds: 3.10, awayOdds: 2.70, startTime: now + 10800000, status: 'upcoming' },
      { id: 'm4', home: 'Italy', away: 'Portugal', homeOdds: 2.80, drawOdds: 3.00, awayOdds: 2.50, startTime: now + 14400000, status: 'upcoming' },
      { id: 'm5', home: 'Netherlands', away: 'Belgium', homeOdds: 2.20, drawOdds: 3.30, awayOdds: 3.10, startTime: now + 18000000, status: 'upcoming' },
    ];
    db.matches = dummyMatches;
    saveDB();
  }
  res.json(db.matches);
});

app.post('/api/sports/bet', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getUser(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { matchId, betType, amount } = req.body;
    if (!matchId || !betType || !amount) return res.status(400).json({ error: 'Missing fields' });
    if (amount <= 0) return res.status(400).json({ error: 'Amount must be positive' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    const match = db.matches.find(m => m.id === matchId);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.status !== 'upcoming') return res.status(400).json({ error: 'Match already finished' });

    let odds, betLabel;
    if (betType === 'home') { odds = match.homeOdds; betLabel = match.home; }
    else if (betType === 'draw') { odds = match.drawOdds; betLabel = 'Draw'; }
    else if (betType === 'away') { odds = match.awayOdds; betLabel = match.away; }
    else return res.status(400).json({ error: 'Invalid bet type' });

    user.balance -= amount;
    saveDB();

    const bet = {
      id: Date.now().toString(),
      userId: user.id,
      matchId,
      match: `${match.home} vs ${match.away}`,
      betType,
      betLabel,
      odds,
      amount,
      potentialWin: amount * odds,
      placedAt: new Date().toISOString(),
      status: 'active'
    };
    db.sportsBets.push(bet);
    saveDB();

    res.json({ success: true, bet, newBalance: user.balance });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.get('/api/sports/history', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const bets = db.sportsBets.filter(b => b.userId === decoded.id);
    res.json(bets);
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Admin: resolve a match
app.post('/api/sports/resolve', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!isAdmin(decoded.id)) return res.status(403).json({ error: 'Unauthorized' });

    const { matchId, winner } = req.body;
    const match = db.matches.find(m => m.id === matchId);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.status === 'finished') return res.status(400).json({ error: 'Already resolved' });

    match.status = 'finished';
    match.result = winner;
    saveDB();

    const bets = db.sportsBets.filter(b => b.matchId === matchId && b.status === 'active');
    for (const bet of bets) {
      if (bet.betType === winner) {
        const user = getUser(bet.userId);
        if (user) {
          const winAmount = bet.amount * bet.odds;
          user.balance += winAmount;
          bet.status = 'won';
          bet.wonAmount = winAmount;
          try {
            bot.sendMessage(bet.userId, `🎉 Your bet on ${bet.match} won! You won ${winAmount.toFixed(2)} ETB!`);
          } catch(e) {}
        }
      } else {
        bet.status = 'lost';
      }
    }
    saveDB();
    res.json({ success: true, settledBets: bets.length });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ---------- TELEGRAM BOT ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    `⚽ *Welcome to Ethiobet!*\n\n` +
    `🎮 100+ Games & Sports Betting\n` +
    `💰 Deposit via Telebirr\n` +
    `✅ Auto-verification\n\n` +
    `Tap the button below to start!`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎮 Play Now', web_app: { url: FRONTEND_URL } }],
          [{ text: '💰 Deposit', callback_data: 'deposit' }],
          [{ text: '⚽ World Cup Bets', web_app: { url: FRONTEND_URL + '?page=sports' } }]
        ]
      }
    }
  );
});

bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  bot.answerCallbackQuery(query.id);
  if (query.data === 'deposit') {
    bot.sendMessage(chatId, 
      `💳 *Deposit Instructions*\n\n` +
      `1️⃣ Send to: *${MERCHANT_PHONE}* via Telebirr\n` +
      `2️⃣ Take a screenshot\n` +
      `3️⃣ Send it here\n` +
      `4️⃣ Auto-verified instantly!`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Auto-verification for deposit screenshots
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
  db.completedDeposits.push({ 
    ...deposit, 
    status: 'approved', 
    verifiedBy: 'auto', 
    verifiedAt: new Date().toISOString(), 
    photoFileId: fileId 
  });
  const idx = db.pendingDeposits.findIndex(d => d.id === deposit.id);
  if (idx !== -1) db.pendingDeposits.splice(idx, 1);
  saveDB();
  bot.sendMessage(chatId, 
    `✅ *Deposit Auto-Approved!*\n\n` +
    `💰 Amount: ${deposit.amount} ETB\n` +
    `📊 New Balance: ${user ? user.balance.toFixed(2) : 'N/A'}`,
    { parse_mode: 'Markdown' }
  );
  ADMIN_IDS.forEach(adminId => {
    bot.sendPhoto(adminId, fileId, { 
      caption: `📸 *Auto-Verified Deposit*\n👤 ${msg.from.first_name} (${chatId})\n💰 ${deposit.amount} ETB\n✅ Status: Auto-approved`,
      parse_mode: 'Markdown'
    });
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
  console.log(`📊 Database: ${DB_PATH}`);
  console.log(`📁 Frontend Path: ${FRONTEND_PATH}`);
  console.log(`📁 Frontend Exists: ${fs.existsSync(FRONTEND_PATH)}`);
  console.log(`📊 Total Users: ${db.users.length}`);
});
