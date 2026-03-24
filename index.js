const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// Config
// ============================================================
const MAX_SESSIONS = 2000; // tăng lên 2000 để học nhiều hơn
const SOURCE_URL = process.env.SOURCE_URL || 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=405f18b5220fdd5674e8bb74bd0d5d14';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 5000;

// ============================================================
// In-memory store
// ============================================================
let sessions = [];
let lastPhien = 0;
let pollerStatus = { lastPoll: null, lastError: null, totalFetched: 0 };

// Prediction log — lưu lại từng dự đoán để tính đúng/sai
// { phien, prediction, confidence, taiPct, xiuPct, actual, correct, timestamp }
const predictionLog = [];
const MAX_PRED_LOG = 500;

// Dự đoán đang chờ kết quả
let pendingPred = null; // { phien (latestPhien khi dự đoán), nextPhien, prediction, ... }

// ============================================================
// Helpers
// ============================================================
function classify(total) { return total <= 10 ? 'xiu' : 'tai'; }

// ============================================================
// StreakBreakAnalyzer — học từ lịch sử khi nào cầu bệt thường bẻ
// ============================================================
const StreakBreakAnalyzer = {
  // Phân tích lịch sử: cầu bệt dài N thì bẻ ở phiên thứ mấy?
  getBreakStats(sess) {
    const results = sess.map(s => s.result);
    const stats = {}; // { N: { breaks: number, continues: number } }
    let i = 0;
    while (i < results.length) {
      // Tìm streak bắt đầu tại i
      const val = results[i];
      let len = 1;
      while (i + len < results.length && results[i + len] === val) len++;
      // Ghi nhận: streak dài `len`, sau đó bẻ (nếu có phiên tiếp theo)
      for (let k = 3; k <= len; k++) {
        if (!stats[k]) stats[k] = { breaks: 0, continues: 0 };
        if (k < len) stats[k].continues++;
        else if (i + len < results.length) stats[k].breaks++; // phiên tiếp theo khác = bẻ
      }
      i += len;
    }
    return stats;
  },

  // Xác suất bẻ khi đang ở streak dài `count`
  breakProbability(sess, count) {
    if (sess.length < 50) return null; // chưa đủ dữ liệu học
    const stats = this.getBreakStats(sess);
    const s = stats[count];
    if (!s || (s.breaks + s.continues) < 5) return null;
    return s.breaks / (s.breaks + s.continues);
  },

  // Quyết định có nên bẻ không dựa trên xác suất học được
  shouldBreak(sess, count) {
    const prob = this.breakProbability(sess, count);
    if (prob === null) {
      // Chưa đủ dữ liệu — dùng rule mặc định thông minh hơn:
      // Streak 3-4: tiếp tục; 5-7: 50/50; 8+: bẻ
      if (count <= 4) return { break: false, prob: null, reason: `Cầu bệt ${count} — còn ngắn, theo chiều` };
      if (count >= 8) return { break: true, prob: null, reason: `Cầu bệt ${count} — quá dài, bẻ` };
      return { break: false, prob: null, reason: `Cầu bệt ${count} — chưa đủ dữ liệu học` };
    }
    const shouldBrk = prob > 0.55; // chỉ bẻ khi xác suất > 55%
    return {
      break: shouldBrk,
      prob: Math.round(prob * 100),
      reason: `Cầu bệt ${count} — xác suất bẻ ${Math.round(prob * 100)}% (từ lịch sử)`
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
  },
  isStrongTrend(sess) {
    const r = this.getRatio(sess, 10);
    if (!r.total) return { strong: false, side: null };
    if (r.taiPct > 70) return { strong: true, side: 'tai' };
    if (r.xiuPct > 70) return { strong: true, side: 'xiu' };
    return { strong: false, side: null };
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
    name: 'Xu hướng xúc xắc', weight: 0.5, correct: 0, total: 0,
    predict(sess) {
      if (sess.length < 10) return null;
      // Xem tổng điểm trung bình 5 phiên gần nhất vs 10 phiên trước đó
      const recent5 = sess.slice(-5).reduce((a, s) => a + s.total, 0) / 5;
      const prev10 = sess.slice(-15, -5).reduce((a, s) => a + s.total, 0) / 10;
      if (Math.abs(recent5 - prev10) < 1) return null;
      const pred = recent5 > prev10 ? 'tai' : 'xiu';
      return { prediction: pred, confidence: 'low', reason: `Tổng TB gần đây ${recent5.toFixed(1)} vs trước ${prev10.toFixed(1)}` };
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
// Pattern discovery (chạy trên toàn bộ dữ liệu)
// ============================================================
const discoveredPatterns = [];

function discoverPatterns() {
  if (sessions.length < 30) return;
  const results = sessions.map(s => s.result); // dùng toàn bộ
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
    if (freq > 0.15) {
      const existing = discoveredPatterns.find(p => p.name === check.name);
      if (!existing) discoveredPatterns.push({ name: check.name, frequency: Math.round(freq * 100) / 100, hits, discoveredAt: new Date().toISOString() });
      else { existing.frequency = Math.round(freq * 100) / 100; existing.hits = hits; existing.updatedAt = new Date().toISOString(); }
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
  lastPredictions = {};

  for (const [key, method] of Object.entries(methods)) {
    const result = method.predict(sessions);
    if (!result) continue;
    votes[result.prediction] += method.weight;
    lastPredictions[key] = result.prediction;
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

  // Lưu pending prediction
  if (prediction && latestPhien) {
    pendingPred = {
      phien: latestPhien,
      nextPhien: latestPhien + 1,
      prediction,
      confidence,
      taiPct: SessionAnalyzer.getRatio(sessions, 10).taiPct,
      xiuPct: SessionAnalyzer.getRatio(sessions, 10).xiuPct,
      timestamp: new Date().toISOString()
    };
  }

  return {
    prediction,
    confidence,
    votes: { tai: Math.round(votes.tai * 100) / 100, xiu: Math.round(votes.xiu * 100) / 100 },
    pattern: PatternAnalyzer.analyze(sessions),
    ratio10: SessionAnalyzer.getRatio(sessions, 10),
    methods: methodResults,
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

      // Check pending prediction trước khi evaluate
      if (pendingPred && pendingPred.nextPhien === phien) {
        const correct = pendingPred.prediction === result;
        predictionLog.push({
          phien,
          prediction: pendingPred.prediction,
          confidence: pendingPred.confidence,
          taiPct: pendingPred.taiPct,
          xiuPct: pendingPred.xiuPct,
          actual: result,
          correct,
          timestamp: new Date().toISOString()
        });
        if (predictionLog.length > MAX_PRED_LOG) predictionLog.shift();
        console.log(`[pred] #${phien} → dự đoán ${pendingPred.prediction} | thực tế ${result} | ${correct ? '✅' : '❌'}`);
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
      // Tạo dự đoán mới ngay sau khi có phiên mới
      buildPrediction();
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
app.get('/predict', (req, res) => res.json(buildPrediction()));

app.get('/history', (req, res) => {
  const n = Math.min(parseInt(req.query.n) || 100, 2000);
  res.json({ total: sessions.length, sessions: sessions.slice(-n).reverse() });
});

// GET /prediction-history — lịch sử đúng/sai
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
