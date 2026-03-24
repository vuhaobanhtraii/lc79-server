const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// Config
// ============================================================
const MAX_SESSIONS = 500;
const SOURCE_URL = process.env.SOURCE_URL || 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=405f18b5220fdd5674e8bb74bd0d5d14';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 5000;

// ============================================================
// In-memory store
// ============================================================
let sessions = []; // { id, phien, dice:[d1,d2,d3], total, result, timestamp }
let lastPhien = 0; // track phiên cuối đã lưu để tránh duplicate
let pollerStatus = { lastPoll: null, lastError: null, totalFetched: 0 };

// ============================================================
// Helpers
// ============================================================
function classify(total) {
  return total <= 10 ? 'xiu' : 'tai';
}

// Map ket_qua string từ API nguồn sang 'tai'/'xiu'
function mapKetQua(str) {
  if (!str) return null;
  const s = str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (s.includes('xiu') || s.includes('xỉu')) return 'xiu';
  if (s.includes('tai') || s.includes('tài')) return 'tai';
  return null;
}

// ============================================================
// PatternAnalyzer
// ============================================================
const PatternAnalyzer = {
  detectBet(results) {
    if (results.length < 3) return { detected: false, count: 0, value: null };
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
  pattern: {
    name: 'Pattern Cầu', weight: 1.0, correct: 0, total: 0,
    predict(sess) {
      if (sess.length < 5) return null;
      const p = PatternAnalyzer.analyze(sess);
      if (p.type === 'bet') {
        const pred = p.count < 5 ? p.currentValue : (p.currentValue === 'tai' ? 'xiu' : 'tai');
        return { prediction: pred, confidence: p.count >= 3 ? 'high' : 'medium', reason: `Cầu bệt ${p.currentValue === 'tai' ? 'Tài' : 'Xỉu'} ${p.count} phiên${p.count >= 5 ? ' — đảo chiều' : ''}` };
      }
      if (p.type === '1-1') {
        const last = sess[sess.length - 1].result;
        return { prediction: last === 'tai' ? 'xiu' : 'tai', confidence: p.count >= 4 ? 'high' : 'medium', reason: `Cầu 1-1 ${p.count} phiên` };
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
  streak_break: {
    name: 'Đảo chiều streak', weight: 0.6, correct: 0, total: 0,
    predict(sess) {
      if (sess.length < 5) return null;
      const results = sess.map(s => s.result);
      const bet = PatternAnalyzer.detectBet(results);
      if (bet.count >= 4) {
        return { prediction: bet.value === 'tai' ? 'xiu' : 'tai', confidence: 'medium', reason: `Streak ${bet.count} phiên — khả năng đảo` };
      }
      return null;
    }
  },
  anti_majority: {
    name: 'Ngược đa số', weight: 0.5, correct: 0, total: 0,
    predict(sess) {
      if (sess.length < 10) return null;
      const r = SessionAnalyzer.getRatio(sess, 20);
      if (r.taiPct > 65) return { prediction: 'xiu', confidence: 'low', reason: `Tài quá nhiều (${r.taiPct}%) — kỳ vọng bù` };
      if (r.xiuPct > 65) return { prediction: 'tai', confidence: 'low', reason: `Xỉu quá nhiều (${r.xiuPct}%) — kỳ vọng bù` };
      return null;
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
      m.weight = Math.max(0.1, Math.min(1.5, 0.3 + acc * 1.2));
    }
  }
  lastPredictions = {};
}

// ============================================================
// Pattern discovery
// ============================================================
const discoveredPatterns = [];

function discoverPatterns() {
  if (sessions.length < 20) return;
  const results = sessions.slice(-50).map(s => s.result);
  const checks = [
    { name: '2-2 (TT-XX)', seq: ['tai','tai','xiu','xiu'] },
    { name: '3-1 (TTT-X)', seq: ['tai','tai','tai','xiu'] },
    { name: '1-3 (X-TTT)', seq: ['xiu','tai','tai','tai'] },
    { name: '2-1 (TT-X)',  seq: ['tai','tai','xiu'] },
    { name: '1-2 (X-TT)',  seq: ['xiu','tai','tai'] },
    { name: '3-3 (TTT-XXX)', seq: ['tai','tai','tai','xiu','xiu','xiu'] },
  ];
  for (const check of checks) {
    const pStr = check.seq.join(',');
    let hits = 0;
    for (let i = 0; i <= results.length - check.seq.length; i++) {
      if (results.slice(i, i + check.seq.length).join(',') === pStr) hits++;
    }
    const freq = hits / Math.max(1, results.length - check.seq.length + 1);
    if (freq > 0.2) {
      const existing = discoveredPatterns.find(p => p.name === check.name);
      if (!existing) discoveredPatterns.push({ name: check.name, frequency: Math.round(freq * 100) / 100, discoveredAt: new Date().toISOString() });
      else { existing.frequency = Math.round(freq * 100) / 100; existing.updatedAt = new Date().toISOString(); }
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

  return {
    prediction,
    confidence,
    votes: { tai: Math.round(votes.tai * 100) / 100, xiu: Math.round(votes.xiu * 100) / 100 },
    pattern: PatternAnalyzer.analyze(sessions),
    ratio10: SessionAnalyzer.getRatio(sessions, 10),
    methods: methodResults,
    sessionCount: sessions.length,
    latestPhien: sessions.length ? sessions[sessions.length - 1].phien : null,
    timestamp: new Date().toISOString()
  };
}

// ============================================================
// Poller — fetch từ SOURCE_URL định kỳ
// ============================================================
async function pollSource() {
  try {
    const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Format mới: { list: [{id, dices, point, resultTruyenThong}], typeStat }
    const list = data.list;
    if (!Array.isArray(list) || !list.length) {
      pollerStatus.lastPoll = new Date().toISOString();
      return;
    }

    // list[0] là phiên mới nhất — xử lý tất cả phiên chưa có trong store
    let newCount = 0;
    // list đã sort mới nhất trước, ta duyệt từ cũ đến mới để push đúng thứ tự
    const sorted = [...list].reverse();
    for (const item of sorted) {
      const phien = item.id;
      if (!phien || phien <= lastPhien) continue;

      const dice = item.dices; // [d1, d2, d3]
      const total = item.point || dice.reduce((a, b) => a + b, 0);
      const raw = (item.resultTruyenThong || '').toUpperCase();
      const result = raw === 'TAI' ? 'tai' : 'xiu';

      // Evaluate accuracy of previous predictions
      evaluatePredictions(result);

      const session = {
        id: phien,
        phien,
        dice,
        total,
        result,
        ket_qua: item.resultTruyenThong,
        timestamp: new Date().toISOString()
      };

      sessions.push(session);
      if (sessions.length > MAX_SESSIONS) sessions = sessions.slice(-MAX_SESSIONS);
      lastPhien = phien;
      newCount++;
    }

    if (newCount > 0) {
      pollerStatus.totalFetched += newCount;
      console.log(`[poll] +${newCount} phiên mới | Phiên mới nhất: #${lastPhien} | Tổng: ${sessions.length}`);
    }

    pollerStatus.lastPoll = new Date().toISOString();
    pollerStatus.lastError = null;
  } catch (e) {
    pollerStatus.lastError = e.message;
    pollerStatus.lastPoll = new Date().toISOString();
    console.warn(`[poll] Lỗi: ${e.message}`);
  }
}

// Start polling
setInterval(pollSource, POLL_INTERVAL_MS);
pollSource(); // chạy ngay khi khởi động

// Background jobs
setInterval(discoverPatterns, 60_000);
setInterval(() => {
  const summary = Object.entries(methods).map(([k, m]) => ({
    key: k, weight: m.weight,
    acc: m.total ? `${Math.round(m.correct / m.total * 100)}%(${m.total})` : 'N/A'
  }));
  console.log('[optimizer]', new Date().toISOString(), JSON.stringify(summary));
}, 30_000);

// ============================================================
// Routes
// ============================================================

// GET /predict
app.get('/predict', (req, res) => res.json(buildPrediction()));

// GET /history
app.get('/history', (req, res) => {
  const n = Math.min(parseInt(req.query.n) || 50, 500);
  res.json({ total: sessions.length, sessions: sessions.slice(-n).reverse() });
});

// GET /stats
app.get('/stats', (req, res) => {
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
    poller: { ...pollerStatus, sourceUrl: SOURCE_URL, intervalMs: POLL_INTERVAL_MS },
    uptime: Math.round(process.uptime()) + 's'
  });
});

// GET /health
app.get('/health', (_, res) => res.json({ status: 'ok', sessions: sessions.length, lastPhien }));

// ============================================================
// Start
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tài Xỉu API on port ${PORT}`);
  console.log(`Polling: ${SOURCE_URL} mỗi ${POLL_INTERVAL_MS}ms`);
});
