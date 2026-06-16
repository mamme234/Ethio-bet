require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Telebirr } = require('telebirr-sdk');

// ---------- CONFIG ----------
const PORT = process.env.PORT || 8080;
const DB_PATH = path.join(__dirname, 'db.json');

// ---------- TELEBIRR INIT ----------
const telebirr = new Telebirr(
  process.env.TELEBIRR_APP_ID,
  process.env.TELEBIRR_APP_KEY,
  process.env.TELEBIRR_SHORT_CODE,
  process.env.TELEBIRR_PUBLIC_KEY
);

// ---------- DATABASE (JSON) ----------
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const defaultDB = { users: {}, nextId: 1 };
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDB, null, 2));
    return defaultDB;
  }
  return JSON.parse(fs.readFileSync(DB_PATH));
}

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

let db = loadDB();

function getUser(userId) {
  if (!db.users[userId]) {
    db.users[userId] = { id: userId, balance: 0, totalBets: 0 };
    saveDB();
  }
  return db.users[userId];
}

// ---------- EXPRESS APP ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, './')));

// ---------- TELEBIRR DEPOSIT ENDPOINT ----------
app.post('/api/deposit', async (req, res) => {
  const { userId, amount, phoneNumber } = req.body;

  if (!userId || !amount || !phoneNumber) {
    return res.status(400).json({ error: 'Missing userId, amount, or phoneNumber' });
  }
  if (amount < 1) {
    return res.status(400).json({ error: 'Amount must be at least 1 ETB' });
  }

  try {
    const outTradeNo = `DEPOSIT_${userId}_${Date.now()}`;
    const nonce = crypto.randomBytes(16).toString('hex');

    const payload = {
      nonce,
      outTradeNo,
      returnUrl: process.env.CALLBACK_URL || 'https://yourdomain.com/api/deposit/callback',
      subject: `Deposit for user ${userId}`,
      timeoutExpress: '30m',
      timestamp: new Date().toISOString(),
      totalAmount: amount.toString(),
      receiveName: 'Your Company Name',
      notifyUrl: process.env.CALLBACK_URL || 'https://yourdomain.com/api/deposit/notify',
    };

    const encryptedData = telebirr.encrypt(payload);
    const signature = telebirr.signData(payload);

    const response = await telebirr.initWebPayment(
      'https://h5pay.trade.pay', // Telebirr payment URL
      signature,
      encryptedData
    );

    if (response.code === 0) {
      // Store pending transaction (optional, for reconciliation)
      res.json({
        success: true,
        paymentUrl: response.data.toPayUrl,
        transactionId: outTradeNo,
      });
    } else {
      res.status(500).json({ error: response.msg || 'Payment initialization failed' });
    }
  } catch (error) {
    console.error('Telebirr deposit error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------- TELEBIRR NOTIFICATION WEBHOOK ----------
app.post('/api/deposit/notify', (req, res) => {
  const encryptedText = req.body; // raw encrypted text

  try {
    const decrypted = telebirr.getDecryptedCallbackNotification(encryptedText);
    console.log('Telebirr notification:', decrypted);

    if (decrypted.tradeStatus === 'SUCCESS') {
      const userId = decrypted.outTradeNo.split('_')[1];
      const amount = parseFloat(decrypted.totalAmount);

      const user = getUser(userId);
      user.balance += amount;
      saveDB();

      console.log(`✅ User ${userId} credited with ${amount} ETB`);
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error('Notification decryption error:', error);
    res.status(400).send('Bad request');
  }
});

// ---------- GAME ENGINE (WebSocket) ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let round = {
  status: 'waiting',
  multiplier: 1.00,
  crashPoint: 1.01,
  bets: {},
  timer: null,
  roundNonce: 0,
};

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function generateCrashPoint(serverSeed, clientSeed, nonce) {
  const hash = crypto
    .createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest('hex');
  const h = parseInt(hash.substring(0, 13), 16);
  const e = Math.pow(2, 52);
  let crash = Math.floor((100 * e - h) / (e - h)) / 100;
  if (crash <= 1.01) crash = 1.01;
  return Math.min(crash, 1000);
}

function startNewRound() {
  if (round.timer) {
    clearInterval(round.timer);
    round.timer = null;
  }

  const serverSeed = crypto.randomBytes(32).toString('hex');
  const clientSeed = 'mini_app_global_seed';
  round.roundNonce = Date.now();
  round.crashPoint = generateCrashPoint(serverSeed, clientSeed, round.roundNonce);
  round.status = 'flying';
  round.multiplier = 1.00;
  round.bets = {};

  broadcast({ type: 'round_started' });

  let startTime = Date.now();
  round.timer = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    let currentMultiplier = 1.00 + elapsed * 1.2;

    if (currentMultiplier >= round.crashPoint) {
      clearInterval(round.timer);
      round.timer = null;
      round.status = 'crashed';
      round.multiplier = parseFloat(round.crashPoint.toFixed(2));

      broadcast({ type: 'game_crashed', multiplier: round.multiplier });
      round.bets = {};

      setTimeout(startNewRound, 3000);
    } else {
      round.multiplier = parseFloat(currentMultiplier.toFixed(2));
      broadcast({ type: 'multiplier_update', multiplier: round.multiplier });
    }
  }, 100);
}

// WebSocket connection
wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  let userId = urlParams.get('userId');
  if (!userId) {
    userId = `user_${db.nextId++}`;
    saveDB();
  }
  ws.userId = userId;
  ws.socketId = crypto.randomUUID();

  const user = getUser(userId);
  ws.send(JSON.stringify({ type: 'init', balance: user.balance, userId }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const user = getUser(ws.userId);

      switch (data.type) {
        case 'place_bet': {
          const amount = parseFloat(data.amount);
          if (isNaN(amount) || amount <= 0) {
            return ws.send(JSON.stringify({ type: 'error', message: 'Invalid bet amount' }));
          }
          if (round.status !== 'waiting' && round.status !== 'flying') {
            return ws.send(JSON.stringify({ type: 'error', message: 'Round not active' }));
          }
          if (round.bets[ws.socketId]) {
            return ws.send(JSON.stringify({ type: 'error', message: 'Bet already placed' }));
          }
          if (user.balance < amount) {
            return ws.send(JSON.stringify({ type: 'error', message: 'Insufficient balance' }));
          }

          user.balance -= amount;
          user.totalBets += 1;
          saveDB();

          round.bets[ws.socketId] = { userId: ws.userId, amount };

          ws.send(JSON.stringify({ type: 'bet_placed', amount, balance: user.balance }));
          break;
        }
        case 'cash_out': {
          if (round.status !== 'flying') {
            return ws.send(JSON.stringify({ type: 'error', message: 'Game is not flying' }));
          }
          const bet = round.bets[ws.socketId];
          if (!bet) {
            return ws.send(JSON.stringify({ type: 'error', message: 'No active bet' }));
          }

          const winAmount = bet.amount * round.multiplier;
          const user = getUser(ws.userId);
          user.balance += winAmount;
          saveDB();

          delete round.bets[ws.socketId];

          ws.send(JSON.stringify({
            type: 'cash_out_success',
            multiplier: round.multiplier,
            winAmount,
            balance: user.balance
          }));
          broadcast({ type: 'user_cashed_out', userId: ws.userId, multiplier: round.multiplier });
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

// Start the first round
setTimeout(startNewRound, 1000);

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
