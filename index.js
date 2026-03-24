const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// Config
// ============================================================
const MAX_SESSIONS = 5000;
const SOURCE_URL = process.env.SOURCE_URL || 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=405f18b5220fdd5674e8bb74bd0d5d14';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 5000;

// ============================================================
// In-memory store
// ============================================================
let sessions = [];
let lastPhien = 0;
let pollerStatus = { lastPoll: null, lastError: null, totalFetched: 0 };

// Prediction log
const predictionLog = [];
const MAX_PRED_LOG = 1000;

// Dự đoán đang chờ — lưu theo phien đã dự đoán
// { forPhien: phien mà dự đoán này áp dụng (phiên TIẾP THEO sau latestPhien),
//   prediction, confidence, taiPct, xiuPct, timestamp }
let pendingPred = null;

// ============================================================
// Helpers
// ============================================================
function classify(total) { return total <= 10 ? 'xiu' : 'tai'; }

// ============================================================
// DiceAnalyzer — phân tích xúc xắc
// ============================================================
const DiceAnalyzer = {
  // Tính variance của 3 viên xúc xắc (spread cao = khó đoán)
  variance(dice) {
    const mean = dice.reduce((a, b) => a + b, 0) / 3;
    return dice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 3;
  },

  // Xem xu hướng từng viên trong N phiên gần nhất
  diceTrend(sess, n = 10) {
    const list = sess.slice(-n);
    if (list.length < 5) return null;
    const avgs = [0, 1, 2].map(i => list.reduce((a, s) => a + s.dice[i], 0) / list.length);
    const totalAvg = avgs.reduce((a, b) => a + b, 0);
    return { avgs, totalAvg, prediction: totalAvg > 10.5 ? 'tai' : 'xiu' };
  },

  // Phát hiện "viên nóng" — viên nào đang cho giá trị cao liên tục
  hotDice(sess, n = 8) {
    const list = sess.slice(-n);
    if (list.length < 4) return null;
    const scores = [0, 1, 2].map(i => list.reduce((a, s) => a + s.dice[i], 0) / list.length);
    const maxIdx = scores.indexOf(Math.max(...scores));
    const minIdx = scores.indexOf(Math.min(...scores));
    return { hot: maxIdx, cold: minIdx, scores };
  },

  // Xem tổng điểm có đang tăng/giảm không (momentum)
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
// StreakBreakAnalyzer — học từ lịch sử khi nào cầu bệt thường bẻ
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

    // Bổ sung: xem xúc xắc có dấu hiệu đảo chiều không
    const momentum = DiceAnalyzer.momentum(sess, 5);
    const currentResult = sess.length ? sess[sess.length - 1].result : null;
    let diceSignal = null;
    if (momentum && currentResult) {
      // Nếu momentum ngược chiều cầu bệt → tín hiệu bẻ
      if (momentum.prediction !== currentResult) diceSignal = 'break';
      else diceSignal = 'continue';
    }

    if (prob === null) {
      // Chưa đủ dữ liệu học — dùng rule + dice signal
      if (count <= 3) return { break: false, prob: null, reason: `Cầu bệt ${count} — còn ngắn, theo chiều` };
      if (count >= 8) {
        const reason = diceSignal === 'continue'
          ? `Cầu bệt ${count} — dài nhưng xúc xắc vẫn theo chiều`
          : `Cầu bệt ${count} — quá dài, bẻ`;
        return { break: diceSignal !== 'continue', prob: null, reason };
      }
      if (count >= 5 && diceSignal === 'break') {
        return { break: true, prob: null, reason: `Cầu bệt ${count} — xúc xắc có dấu hiệu đảo chiều` };
      }
      return { break: false, prob: null, reason: `Cầu bệt ${count} — chưa đủ dữ liệu học` };
    }

    // Có dữ liệu học — kết hợp với dice signal
    let adjustedProb = prob;
    if (diceSignal === 'break') adjustedProb = Math.min(0.95, prob + 0.1);
    if (diceSignal === 'continue') adjustedProb = Math.max(0.05, prob - 0.1);

    const shouldBrk = adjustedProb > 0.52;
    return {
      break: shouldBrk,
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
      if (reps >= 2) {
        return { detected: true, pattern: pattern.join('-'), reps, nextExpected: pattern[0] };
      }
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
// Methods registry
// ============================================================
const methods = {
  smart_pattern: {
    name: 'Cầu thông minh', weight: 1.2, correct: 0, total: 0,
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

  majority: {
    name: 'Đa số 10 phiên', weight: 0.7, correct: 0, total: 0,
    predict(sess) {
      if (sess.length < 5) return null;
      const r = SessionAnalyzer.getRatio(sess, 10);
      const pred = r.taiPct >= r.xiuPct ? 'tai' : 'xiu';
      const pct = Math.max(r.taiPct, r.xiuPct);
      return { prediction: pred, confidence: pct > 70 ? 'high' : pct > 55 ? 'medium' : 'low', reason: `Đa số ${pred === 'tai' ? 'Tài' : 'Xỉu'} ${pct}% trong 10 phiên` };
    }
  },

  majority_30: {
    name: 'Đa số 30 phiên', weight: 0.6, correct: 0, total: 0,
    predict(sess) {
      if (sess.length < 15) return null;
      const r = SessionAnalyzer.getRatio(sess, 30);
      const pred = r.taiPct >= r.xiuPct ? 'tai' : 'xiu';
      const pct = Math.max(r.taiPct, r.xiuPct);
      return { prediction: pred, confidence: pct > 65 ? 'medium' : 'low', reason: `Đa số ${pred === 'tai' ? 'Tài' : 'Xỉu'} ${pct}% trong 30 phiên` };
    }
  },

  anti_majority: {
    name: 'Ngược đa số', weight: 0.5, correct: 0, total: 0,
    predict(sess) {
      if (sess.length < 20) return null;
      const r = SessionAnalyzer.getRatio(sess, 20);
      if (r.taiPct > 68) return { prediction: 'xiu', confidence: 'low', reason: `Tài quá nhiều (${r.taiPct}%) — kỳ vọng bù` };
      if (r.xiuPct > 68) return { prediction: 'tai', confidence: 'low', reason: `Xỉu quá nhiều (${r.xiuPct}%) — kỳ vọng bù` };
      return null;
    }
  },

  dice_trend: {
    name: 'Xu hướng xúc xắc', weight: 0.8, correct: 0, total: 0,
    predict(sess) {
      if (sess.length < 10) return null;
      const trend = DiceAnalyzer.diceTrend(sess, 8);
      if (!trend) return null;
      const momentum = DiceAnalyzer.momentum(sess, 5);
      // Kết hợp trend + momentum
      if (momentum && momentum.prediction === trend.prediction) {
        return {
          prediction: trend.prediction,
          confidence: 'medium',
          reason: `Xúc xắc TB ${trend.totalAvg.toFixed(1)} + momentum ${momentum.delta > 0 ? '↑' : '↓'}${Math.abs(momentum.delta)}`
        };
      }
      const diff = Math.abs(trend.totalAvg - 10.5);
      if (diff < 0.5) return null;
      return {
        prediction: trend.prediction,
        confidence: diff > 1.5 ? 'medium' : 'low',
        reason: `Xúc xắc TB ${trend.totalAvg.toFixed(1)} (${trend.prediction === 'tai' ? 'nghiêng Tài' : 'nghiêng Xỉu'})`
      };
    }
  },

  dice_momentum: {
    name: 'Momentum điểm', weight: 0.6, correct: 0, total: 0,
    predict(sess) {
      if (sess.length < 12) return null;
      const m = DiceAnalyzer.momentum(sess, 6);
      if (!m) return null;
      return {
        prediction: m.prediction,
        confidence: Math.abs(m.delta) > 2 ? 'medium' : 'low',
        reason: `Tổng điểm đang ${m.delta > 0 ? 'tăng' : 'giảm'} (Δ${m.delta})`
      };
    }
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
  }
  lastPredictions = {};
}

// ============================================================
// Pattern discovery
// ============================================================
const discoveredPatterns = [];

function discoverPatterns() {
  if (sessions.length < 30) return;
  const results = sessions.map(s => s.result);
  const checks = [
    { name: '2-2', seq: ['tai','tai','xiu','xiu'] },
    { name: '3-1', seq: ['tai','tai','tai','xiu'] },
    { name: '1-3', seq: ['xiu','tai','tai','tai'] },
    { name: '2-1', seq: ['tai','tai','xiu'] },
    { name: '1-2', seq: ['xiu','tai','tai'] },
    { name: '3-3', seq: ['tai','tai','tai','xiu','xiu','xiu'] },
    { name: '4-1', seq: ['tai','tai','tai','tai','xiu'] },
    { name: '1-4', seq: ['xiu','tai','tai','tai','tai'] },
    { name: '2-2-2', seq: ['tai','tai','xiu','xiu','tai','tai'] },
  ];
  for (const check of checks) {
    const pStr = check.seq.join(',');
    let hits = 0;
    for (let i = 0; i <= results.length - check.seq.length; i++) {
      if (results.slice(i, i + check.seq.length).join(',') === pStr) hits++;
    }
    const freq = hits / Math.max(1, results.length - check.seq.length + 1);
    if (freq > 0.12) {
      const existing = discoveredPatterns.find(p => p.name === check.name);
      if (!existing) discoveredPatterns.push({ name: check.name, frequency: Math.round(freq * 100) / 100, hits, discoveredAt: new Date().toISOString() });
      else { existing.frequency = Math.round(freq * 100) / 100; existing.hits = hits; existing.updatedAt = new Date().toISOString(); }
    }
  }
}

// ============================================================
// Core predict — KHÔNG set pendingPred ở đây
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
    prediction,
    confidence,
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
    const sorted = [...list].reverse(); // cũ → mới

    for (const item of sorted) {
      const phien = item.id;
      if (!phien || phien <= lastPhien) continue;

      const dice = item.dices;
      const total = item.point || dice.reduce((a, b) => a + b, 0);
      const raw = (item.resultTruyenThong || '').toUpperCase();
      const result = raw === 'TAI' ? 'tai' : 'xiu';

      // Check pending prediction: phiên mới > phien đã dự đoán → đây là kết quả
      if (pendingPred && phien > pendingPred.forPhien) {
        const correct = pendingPred.prediction === result;
        predictionLog.push({
          phien,                          // phiên có kết quả thực tế
          predictedAt: pendingPred.forPhien, // phiên lúc dự đoán
          prediction: pendingPred.prediction,
          confidence: pendingPred.confidence,
          taiPct: pendingPred.taiPct,
          xiuPct: pendingPred.xiuPct,
          actual: result,
          correct,
          timestamp: new Date().toISOString()
        });
        if (predictionLog.length > MAX_PRED_LOG) predictionLog.shift();
        console.log(`[pred] Dự đoán tại #${pendingPred.forPhien} → kết quả #${phien}: dự ${pendingPred.prediction} | thực ${result} | ${correct ? '✅' : '❌'}`);
        pendingPred = null;
      }

      evaluatePredictions(result);

      sessions.push({ id: phien, phien, dice, total, result, ket_qua: item.resultTruyenThong, timestamp: new Date().toISOString() });
      if (sessions.length > MAX_SESSIONS) sessions = sessions.slice(-MAX_SESSIONS);
      lastPhien = phien;
      newCount++;
    }

    if (newCount > 0) {
      pollerStatus.totalFetched += newCount;
      console.log(`[poll] +${newCount} | #${lastPhien} | Tổng: ${sessions.length}`);

      // Tạo dự đoán mới SAU KHI đã push session mới
      const pred = buildPrediction();
      lastPredictions = pred.methodPreds || {};

      // Lưu pending — forPhien = phiên mới nhất hiện tại
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

setInterval(pollSource, POLL_INTERVAL_MS);
pollSource();
setInterval(discoverPatterns, 60_000);
setInterval(() => {
  const s = Object.entries(methods).map(([k, m]) => `${k}:${m.total ? Math.round(m.correct/m.total*100)+'%' : 'N/A'}(w${m.weight.toFixed(2)})`).join(' | ');
  console.log('[optimizer]', new Date().toISOString(), s);
}, 30_000);

// ============================================================
// Routes
// ============================================================
app.get('/predict', (req, res) => {
  const pred = buildPrediction();
  // Kèm theo pending info để UI biết đang chờ phiên nào
  res.json({
    ...pred,
    pending: pendingPred ? { forPhien: pendingPred.forPhien, prediction: pendingPred.prediction } : null
  });
});

app.get('/history', (req, res) => {
  const n = Math.min(parseInt(req.query.n) || 100, MAX_SESSIONS);
  res.json({ total: sessions.length, sessions: sessions.slice(-n).reverse() });
});

app.get('/prediction-history', (req, res) => {
  const n = Math.min(parseInt(req.query.n) || 50, MAX_PRED_LOG);
  const done = predictionLog.filter(p => p.actual);
  const correct = done.filter(p => p.correct).length;
  res.json({
    total: predictionLog.length,
    correct,
    accuracy: done.length ? `${Math.round(correct / done.length * 100)}%` : 'N/A',
    log: [...predictionLog].reverse().slice(0, n)
  });
});

app.get('/stats', (req, res) => {
  const breakStats = StreakBreakAnalyzer.getBreakStats(sessions);
  res.json({
    sessionCount: sessions.length,
    lastPhien,
    ratio: SessionAnalyzer.getRatio(sessions, 0),
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tài Xỉu API on port ${PORT}`);
  console.log(`Polling: ${SOURCE_URL} mỗi ${POLL_INTERVAL_MS}ms`);
});
