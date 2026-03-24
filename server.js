const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// Config
// ============================================================
const MAX_SESSIONS = 2000;  // 2000 phiên in-memory — đủ để học pattern, không quá cũ
const MAX_PRED_LOG = 2000;  // 2000 prediction log
const SOURCE_URL = process.env.SOURCE_URL || 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=405f18b5220fdd5674e8bb74bd0d5d14';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 5000;

// ============================================================
// PostgreSQL
// ============================================================
const pool = new Pool(
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function dbInit() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      phien BIGINT PRIMARY KEY,
      dice INTEGER[],
      total INTEGER,
      result TEXT,
      ket_qua TEXT,
      ts TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS prediction_log (
      id SERIAL PRIMARY KEY,
      phien BIGINT,
      predicted_at BIGINT,
      prediction TEXT,
      confidence TEXT,
      tai_pct INTEGER,
      xiu_pct INTEGER,
      actual TEXT,
      correct BOOLEAN,
      ts TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS method_weights (
      key TEXT PRIMARY KEY,
      correct INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      weight NUMERIC DEFAULT 0.5,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('[db] Tables ready');
}

async function dbLoadSessions() {
  const { rows } = await pool.query('SELECT * FROM sessions ORDER BY phien ASC LIMIT $1', [MAX_SESSIONS]);
  return rows.map(r => ({ id: r.phien, phien: r.phien, dice: r.dice, total: r.total, result: r.result, ket_qua: r.ket_qua }));
}

async function dbSaveSession(s) {
  await pool.query(
    `INSERT INTO sessions(phien,dice,total,result,ket_qua) VALUES($1,$2,$3,$4,$5) ON CONFLICT(phien) DO NOTHING`,
    [s.phien, s.dice, s.total, s.result, s.ket_qua]
  );
}

async function dbSavePredLog(entry) {
  await pool.query(
    `INSERT INTO prediction_log(phien,predicted_at,prediction,confidence,tai_pct,xiu_pct,actual,correct)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [entry.phien, entry.predictedAt, entry.prediction, entry.confidence,
     entry.taiPct, entry.xiuPct, entry.actual, entry.correct]
  );
}

async function dbLoadPredLog(n = 1000) {
  const { rows } = await pool.query(
    'SELECT * FROM prediction_log ORDER BY id DESC LIMIT $1', [n]
  );
  return rows.map(r => ({
    phien: r.phien, predictedAt: r.predicted_at, prediction: r.prediction,
    confidence: r.confidence, taiPct: r.tai_pct, xiuPct: r.xiu_pct,
    actual: r.actual, correct: r.correct, timestamp: r.ts
  }));
}

async function dbLoadWeights() {
  const { rows } = await pool.query('SELECT * FROM method_weights');
  return rows;
}

async function dbSaveWeight(key, correct, total, weight) {
  await pool.query(
    `INSERT INTO method_weights(key,correct,total,weight,updated_at)
     VALUES($1,$2,$3,$4,NOW())
     ON CONFLICT(key) DO UPDATE SET correct=$2,total=$3,weight=$4,updated_at=NOW()`,
    [key, correct, total, weight]
  );
}

// ============================================================
// In-memory store
// ============================================================
let sessions = [];
let lastPhien = 0;
let pollerStatus = { lastPoll: null, lastError: null, totalFetched: 0 };
const predictionLog = [];
let pendingPred = null;

// ============================================================
// Helpers
// ============================================================
function classify(total) { return total <= 10 ? 'xiu' : 'tai'; }

// ============================================================
// DiceAnalyzer
// ============================================================
const DiceAnalyzer = {
  variance(dice) {
    const mean = dice.reduce((a, b) => a + b, 0) / 3;
    return dice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 3;
  },
  diceTrend(sess, n = 10) {
    const list = sess.slice(-n);
    if (list.length < 5) return null;
    const avgs = [0, 1, 2].map(i => list.reduce((a, s) => a + s.dice[i], 0) / list.length);
    const totalAvg = avgs.reduce((a, b) => a + b, 0);
    return { avgs, totalAvg, prediction: totalAvg > 10.5 ? 'tai' : 'xiu' };
  },
  hotDice(sess, n = 8) {
    const list = sess.slice(-n);
    if (list.length < 4) return null;
    const scores = [0, 1, 2].map(i => list.reduce((a, s) => a + s.dice[i], 0) / list.length);
    const maxIdx = scores.indexOf(Math.max(...scores));
    const minIdx = scores.indexOf(Math.min(...scores));
    return { hot: maxIdx, cold: minIdx, scores };
  },
  momentum(sess, n = 6) {
    if (sess.length < n + 3) return null;
    const recent = sess.slice(-n).reduce((a, s) => a + s.total, 0) / n;
    const prev = sess.slice(-(n * 2), -n).reduce((a, s) => a + s.total, 0) / n;
    const delta = recent - prev;
    if (Math.abs(delta) < 0.8) return null;
    return { delta: Math.round(delta * 10) / 10, prediction: delta > 0 ? 'tai' : 'xiu' };
  }
};

// ============================================================
// StreakBreakAnalyzer
// ============================================================
const StreakBreakAnalyzer = {
  getBreakStats(sess) {
    const results = sess.map(s => s.result);
    const stats = {};
    let i = 0;
    while (i < results.length) {
      const val = results[i];
      let len = 1;
      while (i + len < results.length && results[i + len] === val) len++;
      for (let k = 3; k <= len; k++) {
        if (!stats[k]) stats[k] = { breaks: 0, continues: 0 };
        if (k < len) stats[k].continues++;
        else if (i + len < results.length) stats[k].breaks++;
      }
      i += len;
    }
    return stats;
  },
  breakProbability(sess, count) {
    if (sess.length < 50) return null;
    const stats = this.getBreakStats(sess);
    const s = stats[count];
    if (!s || (s.breaks + s.continues) < 5) return null;
    return s.breaks / (s.breaks + s.continues);
  },
  shouldBreak(sess, count) {
    const prob = this.breakProbability(sess, count);
    const momentum = DiceAnalyzer.momentum(sess, 5);
    const currentResult = sess.length ? sess[sess.length - 1].result : null;
    let diceSignal = null;
    if (momentum && currentResult) {
      diceSignal = momentum.prediction !== currentResult ? 'break' : 'continue';
    }
    if (prob === null) {
      if (count <= 3) return { break: false, prob: null, reason: `Cầu bệt ${count} — còn ngắn, theo chiều` };
      if (count >= 8) {
        return { break: diceSignal !== 'continue', prob: null, reason: `Cầu bệt ${count} — quá dài, bẻ` };
      }
      if (count >= 5 && diceSignal === 'break') {
        return { break: true, prob: null, reason: `Cầu bệt ${count} — xúc xắc có dấu hiệu đảo chiều` };
      }
      return { break: false, prob: null, reason: `Cầu bệt ${count} — chưa đủ dữ liệu học` };
    }
    let adjustedProb = prob;
    if (diceSignal === 'break') adjustedProb = Math.min(0.95, prob + 0.1);
    if (diceSignal === 'continue') adjustedProb = Math.max(0.05, prob - 0.1);
    return {
      break: adjustedProb > 0.52,
      prob: Math.round(adjustedProb * 100),
      reason: `Cầu bệt ${count} — xác suất bẻ ${Math.round(adjustedProb * 100)}%${diceSignal ? ` (xúc xắc: ${diceSignal === 'break' ? '↩️' : '➡️'})` : ''}`
    };
  }
};

// ============================================================
// PatternAnalyzer
// ============================================================
const PatternAnalyzer = {
  detectBet(results) {
    if (results.length < 2) return { detected: false, count: 0, value: null };
    const last = results[results.length - 1];
    let count = 1;
    for (let i = results.length - 2; i >= 0; i--) {
      if (results[i] === last) count++; else break;
    }
    return count >= 3 ? { detected: true, count, value: last } : { detected: false, count, value: last };
  },
  detect11(results) {
    if (results.length < 4) return { detected: false, count: 0 };
    let count = 1;
    for (let i = results.length - 2; i >= 0; i--) {
      if (results[i] !== results[i + 1]) count++; else break;
    }
    return count >= 4 ? { detected: true, count } : { detected: false, count };
  },
  detectCustom(results) {
    if (results.length < 6) return { detected: false };
    const tail = results.slice(-8);
    for (let plen = 2; plen <= 4; plen++) {
      const pattern = tail.slice(-plen);
      let reps = 1;
      let pos = tail.length - plen * 2;
      while (pos >= 0) {
        const chunk = tail.slice(pos, pos + plen);
        if (chunk.join(',') === pattern.join(',')) { reps++; pos -= plen; } else break;
      }
      if (reps >= 2) return { detected: true, pattern: pattern.join('-'), reps, nextExpected: pattern[0] };
    }
    return { detected: false };
  },
  analyze(sess) {
    if (!sess.length) return { type: 'lon', count: 0, currentValue: null };
    const results = sess.map(s => s.result);
    const bet = this.detectBet(results);
    if (bet.detected) return { type: 'bet', count: bet.count, currentValue: bet.value };
    const alt = this.detect11(results);
    if (alt.detected) return { type: '1-1', count: alt.count, currentValue: results[results.length - 1] };
    const custom = this.detectCustom(results);
    if (custom && custom.detected) return { type: 'custom', count: custom.reps, currentValue: custom.nextExpected, pattern: custom.pattern };
    return { type: 'lon', count: 0, currentValue: results[results.length - 1] };
  }
};

// ============================================================
// SessionAnalyzer
// ============================================================
const SessionAnalyzer = {
  getRatio(sess, n) {
    const list = n > 0 ? sess.slice(-n) : sess;
    const total = list.length;
    if (!total) return { tai: 0, xiu: 0, total: 0, taiPct: 50, xiuPct: 50 };
    const tai = list.filter(s => s.result === 'tai').length;
    const taiPct = Math.round((tai / total) * 100);
    return { tai, xiu: total - tai, total, taiPct, xiuPct: 100 - taiPct };
  }
};

// ============================================================
// DicePatternAnalyzer
// ============================================================
const DicePatternAnalyzer = {
  bucket(v) { return v <= 2 ? 'L' : v <= 4 ? 'M' : 'H'; },
  diceKey(dice) { return dice.map(d => this.bucket(d)).join(''); },
  buildMap(sess) {
    const map = {};
    for (let i = 0; i < sess.length - 1; i++) {
      const key = this.diceKey(sess[i].dice);
      const next = sess[i + 1];
      if (!map[key]) map[key] = { count: 0, tai: 0, xiu: 0, totalSum: 0 };
      map[key].count++;
      map[key][next.result]++;
      map[key].totalSum += next.total;
    }
    return map;
  },
  predict(sess) {
    if (sess.length < 20) return null;
    // Train trên 80% đầu, validate trên 20% cuối
    const splitIdx = Math.floor(sess.length * 0.8);
    const trainSess = sess.slice(0, splitIdx);
    const valSess = sess.slice(splitIdx);
    if (valSess.length < 5) return null;

    const map = this.buildMap(trainSess);
    // Validate trên val set
    let valCorrect = 0, valTotal = 0;
    for (let i = 0; i < valSess.length - 1; i++) {
      const key = this.diceKey(valSess[i].dice);
      const stat = map[key];
      if (!stat || stat.count < 5) continue;
      const pred = stat.tai >= stat.xiu ? 'tai' : 'xiu';
      if (pred === valSess[i + 1].result) valCorrect++;
      valTotal++;
    }
    const valAcc = valTotal >= 5 ? valCorrect / valTotal : 0;
    if (valAcc < 0.55) return null; // không đủ tốt trên val set

    const lastKey = this.diceKey(sess[sess.length - 1].dice);
    const stat = map[lastKey];
    if (!stat || stat.count < 5) return null;
    const taiPct = stat.tai / stat.count;
    const xiuPct = stat.xiu / stat.count;
    const maxPct = Math.max(taiPct, xiuPct);
    if (maxPct < 0.60) return null;

    const pred = taiPct >= xiuPct ? 'tai' : 'xiu';
    const avgTotal = Math.round(stat.totalSum / stat.count * 10) / 10;
    return {
      prediction: pred,
      confidence: maxPct > 0.75 ? 'high' : 'medium',
      reason: `Xúc xắc [${lastKey}] → TB ${avgTotal} | ${stat.tai}T/${stat.xiu}X/${stat.count} mẫu | val ${Math.round(valAcc*100)}%`
    };
  }
};

// ============================================================
// Methods registry
// ============================================================
const methods = {
  smart_pattern: {
    name: 'Cầu thông minh', weight: 1.5, correct: 0, total: 0,
    predict(sess) {
      if (sess.length < 5) return null;
      const p = PatternAnalyzer.analyze(sess);
      if (p.type === 'bet') {
        const breakDecision = StreakBreakAnalyzer.shouldBreak(sess, p.count);
        const pred = breakDecision.break
          ? (p.currentValue === 'tai' ? 'xiu' : 'tai')
          : p.currentValue;
        const conf = breakDecision.prob !== null
          ? (breakDecision.prob > 70 ? 'high' : 'medium')
          : (p.count >= 6 ? 'medium' : 'low');
        return { prediction: pred, confidence: conf, reason: breakDecision.reason };
      }
      if (p.type === '1-1') {
        const last = sess[sess.length - 1].result;
        return { prediction: last === 'tai' ? 'xiu' : 'tai', confidence: p.count >= 6 ? 'high' : 'medium', reason: `Cầu 1-1 ${p.count} phiên` };
      }
      if (p.type === 'custom') {
        return { prediction: p.currentValue, confidence: 'medium', reason: `Pattern lặp ${p.pattern} x${p.count}` };
      }
      return null;
    }
  },
  dice_pattern: {
    name: 'Phân tích xúc xắc', weight: 0.8, correct: 0, total: 0,
    predict(sess) { return DicePatternAnalyzer.predict(sess); }
  }
};

// ============================================================
// Accuracy tracking
// ============================================================
let lastPredictions = {};

function evaluatePredictions(actualResult) {
  for (const [key, pred] of Object.entries(lastPredictions)) {
    const m = methods[key];
    if (!m) continue;
    m.total++;
    if (pred === actualResult) m.correct++;
    if (m.total >= 10) {
      const acc = m.correct / m.total;
      m.weight = Math.max(0.1, Math.min(2.0, 0.2 + acc * 1.8));
    }
    // Persist weight sau mỗi update
    dbSaveWeight(key, m.correct, m.total, m.weight).catch(() => {});
  }
  lastPredictions = {};
}

// ============================================================
// Pattern discovery — với train/val split để chống overfitting
// ============================================================
const discoveredPatterns = [];

function discoverPatterns() {
  if (sessions.length < 50) return;

  // Split: 80% train, 20% val
  const splitIdx = Math.floor(sessions.length * 0.8);
  const trainSess = sessions.slice(0, splitIdx);
  const valSess = sessions.slice(splitIdx);
  const trainResults = trainSess.map(s => s.result);
  const valResults = valSess.map(s => s.result);
  const n = trainResults.length;

  const fixedChecks = [
    { name: '2-2', seq: ['tai','tai','xiu','xiu'] },
    { name: '3-1', seq: ['tai','tai','tai','xiu'] },
    { name: '1-3', seq: ['xiu','xiu','xiu','tai'] },
    { name: '2-1', seq: ['tai','tai','xiu'] },
    { name: '1-2', seq: ['xiu','xiu','tai'] },
    { name: '3-3', seq: ['tai','tai','tai','xiu','xiu','xiu'] },
    { name: '4-1', seq: ['tai','tai','tai','tai','xiu'] },
    { name: '1-4', seq: ['xiu','xiu','xiu','xiu','tai'] },
    { name: '2-2-2', seq: ['tai','tai','xiu','xiu','tai','tai'] },
    { name: '1-1-2', seq: ['tai','xiu','tai','xiu','tai','tai'] },
    { name: '2-1-2', seq: ['tai','tai','xiu','tai','tai'] },
  ];

  // Auto-discover streak patterns từ train set
  const streaks = [];
  let cur = trainResults[0], len = 1;
  for (let i = 1; i < n; i++) {
    if (trainResults[i] === cur) { len++; }
    else { streaks.push({ val: cur, len }); cur = trainResults[i]; len = 1; }
  }
  streaks.push({ val: cur, len });

  const streakPatternMap = {};
  for (let i = 0; i < streaks.length - 3; i++) {
    const key = `${streaks[i].len}-${streaks[i+1].len}-${streaks[i+2].len}`;
    const nextVal = streaks[i+3] ? streaks[i+3].val : null;
    if (!streakPatternMap[key]) streakPatternMap[key] = { count: 0, tai: 0, xiu: 0, firstVal: streaks[i].val };
    streakPatternMap[key].count++;
    if (nextVal === 'tai') streakPatternMap[key].tai++;
    else if (nextVal === 'xiu') streakPatternMap[key].xiu++;
  }

  const autoChecks = [];
  for (const [key, stat] of Object.entries(streakPatternMap)) {
    if (stat.count < 6) continue;
    const nextPred = stat.tai >= stat.xiu ? 'tai' : 'xiu';
    const nextPct = Math.round(Math.max(stat.tai, stat.xiu) / (stat.tai + stat.xiu || 1) * 100);
    if (nextPct < 62) continue;
    const parts = key.split('-').map(Number);
    const seq = [];
    let v = stat.firstVal;
    for (const plen of parts) {
      for (let k = 0; k < plen; k++) seq.push(v);
      v = v === 'tai' ? 'xiu' : 'tai';
    }
    autoChecks.push({ name: `s${key}`, seq, nextPred, nextPct, hits: stat.count });
  }

  const allChecks = [...fixedChecks.map(c => ({ ...c, nextPred: null, nextPct: null, hits: null })), ...autoChecks];

  for (const check of allChecks) {
    const pStr = check.seq.join(',');
    let hits = 0, nextTai = 0, nextXiu = 0;

    // Đếm trên train set
    for (let i = 0; i <= n - check.seq.length - 1; i++) {
      if (trainResults.slice(i, i + check.seq.length).join(',') === pStr) {
        hits++;
        if (trainResults[i + check.seq.length] === 'tai') nextTai++;
        else nextXiu++;
      }
    }
    if (hits < 5) continue;

    const trainPred = nextTai >= nextXiu ? 'tai' : 'xiu';
    const trainPct = Math.round(Math.max(nextTai, nextXiu) / hits * 100);

    // Validate trên val set
    let valHits = 0, valCorrect = 0;
    const vn = valResults.length;
    for (let i = 0; i <= vn - check.seq.length - 1; i++) {
      if (valResults.slice(i, i + check.seq.length).join(',') === pStr) {
        valHits++;
        if (valResults[i + check.seq.length] === trainPred) valCorrect++;
      }
    }
    // Yêu cầu: val set phải có ít nhất 3 hit VÀ accuracy >= 55%
    const valAcc = valHits >= 3 ? valCorrect / valHits : null;
    if (valAcc !== null && valAcc < 0.55) {
      // Pattern không pass validation — xóa method nếu có
      const methodKey = `auto_${check.name.replace(/-/g, '_')}`;
      if (methods[methodKey]) {
        delete methods[methodKey];
        console.log(`[discover] -method: ${methodKey} (val acc ${Math.round(valAcc*100)}% < 55%)`);
      }
      continue;
    }

    const freq = hits / Math.max(1, n - check.seq.length);
    const existing = discoveredPatterns.find(p => p.name === check.name);
    const entry = { name: check.name, frequency: Math.round(freq * 100) / 100, hits, nextPred: trainPred, nextPct: trainPct, valAcc: valAcc ? Math.round(valAcc * 100) : null };
    if (!existing) discoveredPatterns.push({ ...entry, discoveredAt: new Date().toISOString() });
    else Object.assign(existing, { ...entry, updatedAt: new Date().toISOString() });

    const methodKey = `auto_${check.name.replace(/-/g, '_')}`;
    if (trainPct >= 60 && hits >= 8 && (valAcc === null || valAcc >= 0.55)) {
      const seqCopy = [...check.seq];
      const predNext = trainPred;
      const pctCopy = trainPct;
      const hitsCopy = hits;
      const valAccPct = valAcc ? Math.round(valAcc * 100) : null;
      if (!methods[methodKey]) {
        methods[methodKey] = {
          name: `Cầu ${check.name}`, weight: 0.5, correct: 0, total: 0,
          predict(sess) {
            if (sess.length < seqCopy.length) return null;
            const tail = sess.slice(-seqCopy.length).map(s => s.result);
            if (tail.join(',') !== seqCopy.join(',')) return null;
            return {
              prediction: predNext,
              confidence: pctCopy > 75 ? 'high' : 'medium',
              reason: `Cầu ${check.name} → ${predNext === 'tai' ? 'Tài' : 'Xỉu'} (train ${pctCopy}%${valAccPct ? ` / val ${valAccPct}%` : ''} / ${hitsCopy} mẫu)`
            };
          }
        };
        console.log(`[discover] +method: ${methodKey} (train ${trainPct}% / val ${valAcc ? Math.round(valAcc*100)+'%' : 'N/A'})`);
      }
      const acc = trainPct / 100;
      methods[methodKey].weight = Math.max(0.2, Math.min(1.2, 0.1 + acc * 1.1));
    }
  }

  // Xóa method yếu
  for (const [key, m] of Object.entries(methods)) {
    if (!key.startsWith('auto_')) continue;
    if (m.total >= 20 && m.correct / m.total < 0.45) {
      delete methods[key];
      console.log(`[discover] -method: ${key} (accuracy thực tế thấp)`);
    }
  }
}

// ============================================================
// Core predict
// ============================================================
function buildPrediction() {
  if (sessions.length < 5) return { prediction: null, reason: 'Chưa đủ dữ liệu (cần 5 phiên)', confidence: null, methods: [] };

  const votes = { tai: 0, xiu: 0 };
  const methodResults = [];
  const currentPreds = {};

  for (const [key, method] of Object.entries(methods)) {
    const result = method.predict(sessions);
    if (!result) continue;
    votes[result.prediction] += method.weight;
    currentPreds[key] = result.prediction;
    methodResults.push({
      name: method.name,
      prediction: result.prediction,
      confidence: result.confidence,
      reason: result.reason,
      weight: Math.round(method.weight * 100) / 100,
      accuracy: method.total >= 5 ? `${Math.round(method.correct / method.total * 100)}%` : 'N/A'
    });
  }

  const prediction = votes.tai >= votes.xiu ? 'tai' : 'xiu';
  const totalVotes = votes.tai + votes.xiu;
  const winVotes = Math.max(votes.tai, votes.xiu);
  const confidence = totalVotes === 0 ? 'low' : winVotes / totalVotes > 0.75 ? 'high' : winVotes / totalVotes > 0.55 ? 'medium' : 'low';
  const latestPhien = sessions.length ? sessions[sessions.length - 1].phien : null;

  return {
    prediction, confidence,
    votes: { tai: Math.round(votes.tai * 100) / 100, xiu: Math.round(votes.xiu * 100) / 100 },
    pattern: PatternAnalyzer.analyze(sessions),
    ratio10: SessionAnalyzer.getRatio(sessions, 10),
    methods: methodResults,
    methodPreds: currentPreds,
    sessionCount: sessions.length,
    latestPhien,
    timestamp: new Date().toISOString()
  };
}

// ============================================================
// Accuracy stats helper
// ============================================================
function calcAccuracyStats(log) {
  const done = log.filter(p => p.actual);
  const calc = (arr) => {
    if (!arr.length) return { correct: 0, total: 0, pct: null };
    const correct = arr.filter(p => p.correct).length;
    return { correct, total: arr.length, pct: Math.round(correct / arr.length * 100) };
  };
  return {
    all: calc(done),
    last10: calc(done.slice(0, 10)),
    last50: calc(done.slice(0, 50)),
    last100: calc(done.slice(0, 100)),
  };
}

// ============================================================
// Poller
// ============================================================
async function pollSource() {
  try {
    const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const list = data.list;
    if (!Array.isArray(list) || !list.length) { pollerStatus.lastPoll = new Date().toISOString(); return; }

    let newCount = 0;
    const sorted = [...list].reverse();

    for (const item of sorted) {
      const phien = item.id;
      if (!phien || phien <= lastPhien) continue;

      const dice = item.dices;
      const total = item.point || dice.reduce((a, b) => a + b, 0);
      const raw = (item.resultTruyenThong || '').toUpperCase();
      const result = raw === 'TAI' ? 'tai' : 'xiu';

      if (pendingPred && phien > pendingPred.forPhien) {
        const correct = pendingPred.prediction === result;
        const logEntry = {
          phien, predictedAt: pendingPred.forPhien,
          prediction: pendingPred.prediction, confidence: pendingPred.confidence,
          taiPct: pendingPred.taiPct, xiuPct: pendingPred.xiuPct,
          actual: result, correct, timestamp: new Date().toISOString()
        };
        predictionLog.unshift(logEntry);
        if (predictionLog.length > MAX_PRED_LOG) predictionLog.pop();
        dbSavePredLog(logEntry).catch(() => {});
        console.log(`[pred] #${pendingPred.forPhien} → kết quả #${phien}: dự ${pendingPred.prediction} | thực ${result} | ${correct ? '✅' : '❌'}`);
        pendingPred = null;
      }

      evaluatePredictions(result);

      const sess = { id: phien, phien, dice, total, result, ket_qua: item.resultTruyenThong, timestamp: new Date().toISOString() };
      sessions.push(sess);
      if (sessions.length > MAX_SESSIONS) sessions = sessions.slice(-MAX_SESSIONS);
      lastPhien = phien;
      newCount++;
      dbSaveSession(sess).catch(() => {});
    }

    if (newCount > 0) {
      pollerStatus.totalFetched += newCount;
      console.log(`[poll] +${newCount} | #${lastPhien} | Tổng: ${sessions.length}`);
      const pred = buildPrediction();
      lastPredictions = pred.methodPreds || {};
      if (pred.prediction && pred.latestPhien) {
        pendingPred = {
          forPhien: pred.latestPhien,
          prediction: pred.prediction,
          confidence: pred.confidence,
          taiPct: pred.ratio10 ? pred.ratio10.taiPct : 50,
          xiuPct: pred.ratio10 ? pred.ratio10.xiuPct : 50,
          timestamp: new Date().toISOString()
        };
        console.log(`[pred] Dự đoán cho phiên sau #${pred.latestPhien}: ${pred.prediction} (${pred.confidence})`);
      }
    }

    pollerStatus.lastPoll = new Date().toISOString();
    pollerStatus.lastError = null;
  } catch (e) {
    pollerStatus.lastError = e.message;
    pollerStatus.lastPoll = new Date().toISOString();
    console.warn(`[poll] Lỗi: ${e.message}`);
  }
}

// ============================================================
// Routes
// ============================================================
app.get('/predict', (req, res) => {
  const pred = buildPrediction();
  const stats = calcAccuracyStats(predictionLog);
  res.json({
    ...pred,
    pending: pendingPred ? { forPhien: pendingPred.forPhien, prediction: pendingPred.prediction } : null,
    accuracyStats: stats
  });
});

app.get('/history', (req, res) => {
  const n = Math.min(parseInt(req.query.n) || 100, MAX_SESSIONS);
  res.json({ total: sessions.length, sessions: sessions.slice(-n).reverse() });
});

app.get('/prediction-history', (req, res) => {
  const n = Math.min(parseInt(req.query.n) || 50, MAX_PRED_LOG);
  const stats = calcAccuracyStats(predictionLog);
  res.json({
    total: predictionLog.length,
    ...stats,
    log: predictionLog.slice(0, n)
  });
});

app.get('/stats', (req, res) => {
  const breakStats = StreakBreakAnalyzer.getBreakStats(sessions);
  const stats = calcAccuracyStats(predictionLog);
  res.json({
    sessionCount: sessions.length,
    lastPhien,
    ratio: SessionAnalyzer.getRatio(sessions, 0),
    accuracyStats: stats,
    methods: Object.entries(methods).map(([key, m]) => ({
      key, name: m.name,
      weight: Math.round(m.weight * 100) / 100,
      correct: m.correct, total: m.total,
      accuracy: m.total ? `${Math.round(m.correct / m.total * 100)}%` : 'N/A'
    })),
    discoveredPatterns,
    breakStats,
    poller: { ...pollerStatus, sourceUrl: SOURCE_URL, intervalMs: POLL_INTERVAL_MS },
    uptime: Math.round(process.uptime()) + 's'
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok', sessions: sessions.length, lastPhien }));

// ============================================================
// Boot
// ============================================================
async function boot() {
  if (process.env.DATABASE_URL) {
    await dbInit();
    // Load sessions từ DB
    const dbSessions = await dbLoadSessions();
    if (dbSessions.length) {
      sessions = dbSessions;
      lastPhien = sessions[sessions.length - 1].phien;
      console.log(`[db] Loaded ${sessions.length} sessions, lastPhien=${lastPhien}`);
    }
    // Load prediction log từ DB
    const dbLog = await dbLoadPredLog(MAX_PRED_LOG);
    predictionLog.push(...dbLog);
    console.log(`[db] Loaded ${predictionLog.length} prediction log entries`);
    // Load weights từ DB
    const dbWeights = await dbLoadWeights();
    for (const row of dbWeights) {
      if (methods[row.key]) {
        methods[row.key].correct = row.correct;
        methods[row.key].total = row.total;
        methods[row.key].weight = parseFloat(row.weight);
        console.log(`[db] Restored weight: ${row.key} = ${row.weight} (${row.correct}/${row.total})`);
      }
    }
  } else {
    console.warn('[db] DATABASE_URL không có — chạy in-memory only');
  }

  setInterval(pollSource, POLL_INTERVAL_MS);
  pollSource();
  setInterval(discoverPatterns, 60_000);
  setInterval(() => {
    const s = Object.entries(methods).map(([k, m]) => `${k}:${m.total ? Math.round(m.correct/m.total*100)+'%' : 'N/A'}(w${m.weight.toFixed(2)})`).join(' | ');
    console.log('[optimizer]', new Date().toISOString(), s);
  }, 30_000);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Tài Xỉu API on port ${PORT}`);
    console.log(`Polling: ${SOURCE_URL} mỗi ${POLL_INTERVAL_MS}ms`);
  });
}

boot().catch(e => { console.error('[boot] Fatal:', e); process.exit(1); });
