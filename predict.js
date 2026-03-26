const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

const PORT = process.env.PORT || 5000;
const LC79_API = 'https://lc79-server-production.up.railway.app';
const CHECK_INTERVAL = 3000;
const WAIT_AFTER_RESULT = 5000;
const LEARNING_DATA_FILE = './learning_data.json';
const MAX_HISTORY = 500;

let currentPrediction = null;
let predictionHistory = [];
let lastProcessedPhien = null;
let historyCache = { data: [], timestamp: 0 };
const CACHE_TTL = 2000;
let breakDetectionData = { consecutiveWrong: 0, riskLevel: 'low' };

// ── Load/Save learning data ──
function loadLearningData() {
  try {
    if (fs.existsSync(LEARNING_DATA_FILE))
      return JSON.parse(fs.readFileSync(LEARNING_DATA_FILE, 'utf8'));
  } catch (e) {}
  return {};
}
const JSONBIN_URL = process.env.JSONBIN_URL || null; // Set trong Railway env vars
const JSONBIN_KEY = process.env.JSONBIN_KEY || null;

async function loadLearningDataRemote() {
  if (!JSONBIN_URL || !JSONBIN_KEY) return {};
  try {
    const res = await axios.get(JSONBIN_URL, { headers: { 'X-Master-Key': JSONBIN_KEY }, timeout: 5000 });
    console.log('✅ Load learning data từ JSONBin');
    return res.data.record || res.data || {};
  } catch (e) { console.log('⚠️ Không load được learning data:', e.message); return {}; }
}

async function saveLearningDataRemote() {
  if (!JSONBIN_URL || !JSONBIN_KEY) return;
  try {
    await axios.put(JSONBIN_URL, patternLearningData, { headers: { 'X-Master-Key': JSONBIN_KEY, 'Content-Type': 'application/json' }, timeout: 5000 });
  } catch (e) { console.error('❌ Lưu learning data thất bại:', e.message); }
}

function saveLearningData() {
  saveLearningDataRemote();
}

let patternLearningData = {};
const defaultPatterns = ['cau_bet','cau_dao_1_1','cau_1_2_3','cau_3_2_1','cau_2_2','cau_2_1_2',
  'nhip_nghieng_5','nhip_nghieng_7','gap_thep_martingale','phan_tich_tong','phan_tich_xuc_xac',
  'xu_huong_manh','cau_nhay','fibonacci','odd_even_analysis','total_sum_trend','house_intervention'];
defaultPatterns.forEach(p => {
  if (!patternLearningData[p])
    patternLearningData[p] = { total: 0, correct: 0, confidence_adjustment: 0, recent_performance: [] };
});

function updatePatternLearning(pattern, isCorrect) {
  if (!patternLearningData[pattern])
    patternLearningData[pattern] = { total: 0, correct: 0, confidence_adjustment: 0, recent_performance: [] };
  const d = patternLearningData[pattern];
  d.total++; if (isCorrect) d.correct++;
  d.recent_performance.unshift(isCorrect ? 1 : 0);
  if (d.recent_performance.length > 20) d.recent_performance.pop();
  const accuracy = d.correct / d.total;
  let recentAccuracy = accuracy;
  if (d.recent_performance.length >= 5) {
    let ws = 0, wt = 0;
    d.recent_performance.forEach((v, i) => { const w = 1/(i+1); ws += v*w; wt += w; });
    recentAccuracy = ws / wt;
  }
  const fa = accuracy * 0.4 + recentAccuracy * 0.6;
  if (d.total >= 3) {
    if (fa >= 0.75) d.confidence_adjustment = 8;
    else if (fa >= 0.65) d.confidence_adjustment = 5;
    else if (fa >= 0.58) d.confidence_adjustment = 3;
    else if (fa >= 0.52) d.confidence_adjustment = 0;
    else if (fa >= 0.45) d.confidence_adjustment = -3;
    else if (fa >= 0.38) d.confidence_adjustment = -5;
    else d.confidence_adjustment = -8;
  }
  if (d.total % 5 === 0) saveLearningData();
}

function adj(pattern, base) {
  const d = patternLearningData[pattern];
  if (d && d.total >= 3) return Math.max(55, Math.min(85, base + d.confidence_adjustment));
  return Math.max(55, Math.min(85, base));
}

// ── Fetch từ lc79 (field: Phien, Xuc_xac_1, Ket_qua, Tong) ──
async function fetchHistory() {
  const now = Date.now();
  if (historyCache.data.length > 0 && now - historyCache.timestamp < CACHE_TTL)
    return historyCache.data;
  try {
    const [r1, r2] = await Promise.all([
      axios.get(LC79_API + '/', { timeout: 5000 }),
      axios.get(LC79_API + '/api/lichsu', { timeout: 5000 })
    ]);
    // Chuẩn hóa về lowercase để dùng với thuật toán
    const ls = Array.isArray(r2.data) ? r2.data.map(p => ({
      phien: p.Phien, ket_qua: p.Ket_qua,
      xuc_xac_1: p.Xuc_xac_1, xuc_xac_2: p.Xuc_xac_2, xuc_xac_3: p.Xuc_xac_3,
      tong: p.Tong
    })) : [];
    historyCache.data = ls.slice(0, MAX_HISTORY);
    historyCache.timestamp = now;
    return historyCache.data;
  } catch (e) {
    console.error('❌ Fetch lc79 thất bại:', e.message);
    return historyCache.data || [];
  }
}

// ── Thuật toán ──
function analyzeCauBet(h) {
  if (h.length < 3) return null;
  let n = 1, last = h[0].ket_qua;
  for (let i = 1; i < Math.min(h.length, 20); i++) { if (h[i].ket_qua === last) n++; else break; }
  if (n < 3) return null;
  const pred = n >= 6 ? (last === 'Tài' ? 'Xỉu' : 'Tài') : last;
  const base = n >= 6 ? Math.min(62 + (n-6)*2, 72) : 56 + n;
  return { pattern: 'cau_bet', prediction: pred, confidence: adj('cau_bet', base), description: `Cầu bệt ${n} phiên ${last}` };
}
function analyzeCauDao11(h) {
  if (h.length < 3) return null;
  let n = 0;
  for (let i = 0; i < Math.min(h.length,10)-1; i++) { if (h[i].ket_qua !== h[i+1].ket_qua) n++; else break; }
  if (n < 3) return null;
  return { pattern: 'cau_dao_1_1', prediction: h[0].ket_qua === 'Tài' ? 'Xỉu' : 'Tài', confidence: adj('cau_dao_1_1', 58 + Math.min(n-3,5)*2), description: `Cầu đảo 1-1: ${n} lần` };
}
function analyzeCau123(h) {
  if (h.length < 6) return null;
  const r = h.slice(0,6);
  if (r[0].ket_qua===r[1].ket_qua && r[0].ket_qua!==r[2].ket_qua && r[2].ket_qua===r[3].ket_qua && r[2].ket_qua===r[4].ket_qua && r[2].ket_qua!==r[5].ket_qua)
    return { pattern: 'cau_1_2_3', prediction: r[2].ket_qua, confidence: adj('cau_1_2_3', 63), description: 'Cầu 1-2-3' };
  return null;
}
function analyzeCau321(h) {
  if (h.length < 6) return null;
  const r = h.slice(0,6);
  if (r[0].ket_qua===r[1].ket_qua && r[0].ket_qua===r[2].ket_qua && r[0].ket_qua!==r[3].ket_qua && r[3].ket_qua===r[4].ket_qua && r[3].ket_qua!==r[5].ket_qua)
    return { pattern: 'cau_3_2_1', prediction: r[5].ket_qua==='Tài'?'Xỉu':'Tài', confidence: adj('cau_3_2_1', 62), description: 'Cầu 3-2-1' };
  return null;
}
function analyzeCau22(h) {
  if (h.length < 6) return null;
  const r = h.slice(0,6);
  if (r[0].ket_qua===r[1].ket_qua && r[0].ket_qua!==r[2].ket_qua && r[2].ket_qua===r[3].ket_qua && r[0].ket_qua===r[4].ket_qua && r[0].ket_qua===r[5].ket_qua)
    return { pattern: 'cau_2_2', prediction: r[0].ket_qua==='Tài'?'Xỉu':'Tài', confidence: adj('cau_2_2', 65), description: 'Cầu 2-2 mạnh' };
  if (r[0].ket_qua===r[1].ket_qua && r[0].ket_qua!==r[2].ket_qua && r[2].ket_qua===r[3].ket_qua)
    return { pattern: 'cau_2_2', prediction: r[2].ket_qua==='Tài'?'Xỉu':'Tài', confidence: adj('cau_2_2', 62), description: 'Cầu 2-2 hình thành' };
  return null;
}
function analyzeCau212(h) {
  if (h.length < 5) return null;
  const r = h.slice(0,5);
  if (r[0].ket_qua===r[1].ket_qua && r[0].ket_qua!==r[2].ket_qua && r[2].ket_qua!==r[3].ket_qua && r[3].ket_qua===r[4].ket_qua && r[0].ket_qua===r[3].ket_qua)
    return { pattern: 'cau_2_1_2', prediction: r[0].ket_qua==='Tài'?'Xỉu':'Tài', confidence: adj('cau_2_1_2', 64), description: 'Cầu 2-1-2' };
  return null;
}
function analyzeNghieng5(h) {
  if (h.length < 5) return null;
  const t = h.slice(0,5).filter(x=>x.ket_qua==='Tài').length;
  if (t===4) return { pattern: 'nhip_nghieng_5', prediction: 'Tài', confidence: adj('nhip_nghieng_5', 61), description: '4/5 Tài' };
  if (t===1) return { pattern: 'nhip_nghieng_5', prediction: 'Xỉu', confidence: adj('nhip_nghieng_5', 61), description: '4/5 Xỉu' };
  return null;
}
function analyzeNghieng7(h) {
  if (h.length < 7) return null;
  const t = h.slice(0,7).filter(x=>x.ket_qua==='Tài').length;
  if (t >= 5) return { pattern: 'nhip_nghieng_7', prediction: 'Tài', confidence: adj('nhip_nghieng_7', 64+(t-5)*2), description: `${t}/7 Tài` };
  if (7-t >= 5) return { pattern: 'nhip_nghieng_7', prediction: 'Xỉu', confidence: adj('nhip_nghieng_7', 64+(7-t-5)*2), description: `${7-t}/7 Xỉu` };
  return null;
}
function analyzeTong(h) {
  if (h.length < 5) return null;
  const totals = h.slice(0,5).map(x=>parseInt(x.tong)).filter(t=>!isNaN(t));
  if (totals.length !== 5) return null;
  const avg = totals.reduce((a,b)=>a+b,0)/5;
  if (avg >= 12) return { pattern: 'phan_tich_tong', prediction: 'Tài', confidence: adj('phan_tich_tong', 59), description: `TB tổng: ${avg.toFixed(1)}` };
  if (avg <= 9) return { pattern: 'phan_tich_tong', prediction: 'Xỉu', confidence: adj('phan_tich_tong', 59), description: `TB tổng: ${avg.toFixed(1)}` };
  return null;
}
function analyzeXucXac(h) {
  if (h.length < 10) return null;
  let chan=0, le=0;
  h.slice(0,10).forEach(x => {
    const [a,b,c] = [parseInt(x.xuc_xac_1),parseInt(x.xuc_xac_2),parseInt(x.xuc_xac_3)];
    if (!isNaN(a)&&!isNaN(b)&&!isNaN(c)) { if ([a,b,c].filter(v=>v%2===0).length>=2) chan++; else le++; }
  });
  if (chan>=7) return { pattern: 'phan_tich_xuc_xac', prediction: 'Tài', confidence: adj('phan_tich_xuc_xac', 58), description: `Xúc xắc chẵn: ${chan}/10` };
  if (le>=7) return { pattern: 'phan_tich_xuc_xac', prediction: 'Xỉu', confidence: adj('phan_tich_xuc_xac', 58), description: `Xúc xắc lẻ: ${le}/10` };
  return null;
}
function analyzeXuHuong(h) {
  if (h.length < 15) return null;
  const t = h.slice(0,15).filter(x=>x.ket_qua==='Tài').length;
  if (t>=11) return { pattern: 'xu_huong_manh', prediction: 'Tài', confidence: adj('xu_huong_manh', 66+(t-11)*2), description: `${t}/15 Tài` };
  if (15-t>=11) return { pattern: 'xu_huong_manh', prediction: 'Xỉu', confidence: adj('xu_huong_manh', 66+(15-t-11)*2), description: `${15-t}/15 Xỉu` };
  return null;
}
function analyzeCauNhay(h) {
  if (h.length < 10) return null;
  let changes=0;
  for (let i=0;i<9;i++) if (h[i].ket_qua!==h[i+1].ket_qua) changes++;
  if (changes>=7) return { pattern: 'cau_nhay', prediction: h[0].ket_qua==='Tài'?'Xỉu':'Tài', confidence: adj('cau_nhay', 58), description: `Cầu nhảy: ${changes}/9` };
  return null;
}
function analyzeGapThep(h) {
  if (h.length < 5) return null;
  let n=1, last=h[0].ket_qua;
  for (let i=1;i<Math.min(h.length,15);i++) { if (h[i].ket_qua===last) n++; else break; }
  if (n>=2) return { pattern: 'gap_thep_martingale', prediction: last, confidence: adj('gap_thep_martingale', Math.min(57+(n-2)*2,70)), description: `Gấp thếp: ${n} phiên ${last}` };
  return null;
}
function analyzeFibonacci(h) {
  if (h.length < 10) return null;
  const tPos=[], xPos=[];
  h.slice(0,10).forEach((x,i)=>{ if(x.ket_qua==='Tài') tPos.push(i); else xPos.push(i); });
  const chk = pos => { if(pos.length<3) return false; const g=[]; for(let i=1;i<pos.length;i++) g.push(pos[i]-pos[i-1]); return g.length>=2&&Math.abs(g[g.length-1]-g[g.length-2])<=2; };
  if (chk(tPos)) return { pattern: 'fibonacci', prediction: 'Tài', confidence: adj('fibonacci', 60), description: 'Fibonacci Tài' };
  if (chk(xPos)) return { pattern: 'fibonacci', prediction: 'Xỉu', confidence: adj('fibonacci', 60), description: 'Fibonacci Xỉu' };
  return null;
}
function analyzeOddEven(h) {
  if (h.length < 8) return null;
  let chan=0, le=0;
  h.slice(0,8).forEach(x=>{ const t=parseInt(x.tong); if(!isNaN(t)){ if(t%2===0) chan++; else le++; } });
  if (chan>=6) return { pattern: 'odd_even_analysis', prediction: 'Tài', confidence: adj('odd_even_analysis', 59), description: `Tổng chẵn: ${chan}/8` };
  if (le>=6) return { pattern: 'odd_even_analysis', prediction: 'Xỉu', confidence: adj('odd_even_analysis', 59), description: `Tổng lẻ: ${le}/8` };
  return null;
}
function analyzeTongTrend(h) {
  if (h.length < 6) return null;
  const totals = h.slice(0,6).map(x=>parseInt(x.tong)).filter(t=>!isNaN(t));
  if (totals.length!==6) return null;
  let up=0, down=0;
  for (let i=1;i<totals.length;i++) { if(totals[i]>totals[i-1]) up++; if(totals[i]<totals[i-1]) down++; }
  if (up>=4) return { pattern: 'total_sum_trend', prediction: 'Tài', confidence: adj('total_sum_trend', 61), description: `Tổng tăng: ${up}/5` };
  if (down>=4) return { pattern: 'total_sum_trend', prediction: 'Xỉu', confidence: adj('total_sum_trend', 61), description: `Tổng giảm: ${down}/5` };
  return null;
}
function detectHouseIntervention(h, preds) {
  if (h.length<20||preds.length<10) return null;
  let score=0; const signals=[];
  const recentPreds = preds.filter(p=>p.kq_du_doan!=='dang_doi').slice(0,10);
  if (recentPreds.length>=8) {
    const wrongRate = recentPreds.filter(p=>p.kq_du_doan==='sai').length/recentPreds.length*100;
    if (wrongRate>=70) { score+=35; signals.push(`Tỷ lệ sai: ${wrongRate.toFixed(0)}%`); }
  }
  const t10 = h.slice(0,10).filter(x=>x.ket_qua==='Tài').length;
  if (t10>=9||10-t10>=9) { score+=20; signals.push('Mất cân bằng 10 ván'); }
  const extremes = h.slice(0,20).map(x=>parseInt(x.tong)).filter(t=>!isNaN(t)&&(t<=4||t>=17));
  if (extremes.length>=5) { score+=25; signals.push(`Tổng cực đoan: ${extremes.length}/20`); }
  if (score>=50) return { pattern: 'house_intervention', prediction: h[0].ket_qua==='Tài'?'Xỉu':'Tài', confidence: adj('house_intervention', Math.min(58+score/8,72)), description: `Can thiệp nhà cái: ${score}/100`, intervention_signals: signals };
  return null;
}
function detectBreakPattern(h, preds) {
  let prob=0; const signals=[];
  if (breakDetectionData.consecutiveWrong>=5) { prob+=30; signals.push(`${breakDetectionData.consecutiveWrong} lần sai liên tiếp`); }
  if (breakDetectionData.consecutiveWrong>=3) prob+=18;
  const r10 = preds.filter(p=>p.kq_du_doan!=='dang_doi').slice(0,10);
  if (r10.length>=10) { const acc=r10.filter(p=>p.kq_du_doan==='dung').length/10*100; if(acc<35){prob+=25;signals.push(`Độ chính xác: ${acc.toFixed(0)}%`);} else if(acc<50){prob+=15;signals.push(`Độ chính xác thấp: ${acc.toFixed(0)}%`);} }
  if (h.length>=5&&h.slice(0,5).every(r=>r.ket_qua===h[0].ket_qua)) { prob+=18; signals.push('5 phiên cùng kết quả'); }
  prob = Math.min(prob, 98);
  let riskLevel='safe', recommendation='✅ AN TOÀN';
  if (prob>=65) { riskLevel='critical'; recommendation='🛑 DỪNG NGAY'; }
  else if (prob>=50) { riskLevel='high'; recommendation='⛔ NGUY HIỂM'; }
  else if (prob>=35) { riskLevel='medium'; recommendation='⚠️ CẢNH BÁO'; }
  else if (prob>=20) { riskLevel='low_warning'; recommendation='⚡ CHÚ Ý'; }
  breakDetectionData.riskLevel = riskLevel;
  return { risk_level: riskLevel, break_probability: prob, suspicious_signals: signals, recommendation };
}

// ── Tạo dự đoán ──
async function generatePrediction() {
  const h = await fetchHistory();
  if (!h.length) return null;
  const currentPhien = h[0].phien;
  if (currentPhien === lastProcessedPhien) return currentPrediction;

  const algos = [analyzeCauBet,analyzeCauDao11,analyzeCau123,analyzeCau321,analyzeCau22,analyzeCau212,
    analyzeNghieng5,analyzeNghieng7,analyzeTong,analyzeXucXac,analyzeXuHuong,analyzeCauNhay,
    analyzeGapThep,analyzeFibonacci,analyzeOddEven,analyzeTongTrend];
  const preds = algos.map(fn=>fn(h)).filter(Boolean);
  const house = detectHouseIntervention(h, predictionHistory);
  if (house) preds.push(house);
  if (!preds.length) return null;

  preds.sort((a,b)=>b.confidence-a.confidence);
  const best = preds[0];
  const taiV = preds.filter(p=>p.prediction==='Tài').length;
  const xiuV = preds.filter(p=>p.prediction==='Xỉu').length;
  let finalPred = best.prediction, finalConf = best.confidence;
  if (preds.length>=3) {
    if (taiV>xiuV*2) { finalPred='Tài'; finalConf=Math.min(finalConf+2,85); }
    else if (xiuV>taiV*2) { finalPred='Xỉu'; finalConf=Math.min(finalConf+2,85); }
  }
  finalConf = Math.max(55, Math.min(85, finalConf));
  const breakDetect = detectBreakPattern(h, predictionHistory);

  const newPred = {
    phien: (currentPhien+1).toString(),
    du_doan: finalPred,
    ti_le_thang: finalConf.toFixed(0)+'%',
    thuat_toan: best.pattern,
    mo_ta: best.description,
    so_pattern: preds.length,
    tai_votes: taiV, xiu_votes: xiuV,
    top_patterns: preds.slice(0,5).map(p=>({ pattern:p.pattern, prediction:p.prediction, confidence:p.confidence.toFixed(0)+'%', description:p.description })),
    break_detection: { risk_level: breakDetect.risk_level, break_probability: breakDetect.break_probability+'%', recommendation: breakDetect.recommendation, signals: breakDetect.suspicious_signals },
    house_intervention: house ? { detected:true, signals:house.intervention_signals } : { detected:false },
    kq_du_doan: 'dang_doi', ket_qua: null,
    xuc_xac_1: null, xuc_xac_2: null, xuc_xac_3: null, tong: null,
    timestamp: new Date().toISOString()
  };

  currentPrediction = newPred;
  predictionHistory.unshift(newPred);
  if (predictionHistory.length > MAX_HISTORY) predictionHistory = predictionHistory.slice(0, MAX_HISTORY);
  lastProcessedPhien = currentPhien;
  console.log(`🎲 Phiên #${currentPhien+1}: ${finalPred} (${finalConf.toFixed(0)}%) - ${best.pattern} | ${preds.length} patterns`);
  return newPred;
}

async function updateResults() {
  const h = await fetchHistory();
  if (!h.length) return;
  const latest = h[0];
  for (const p of predictionHistory) {
    if (p.phien === latest.phien.toString() && p.kq_du_doan === 'dang_doi') {
      p.ket_qua = latest.ket_qua;
      p.xuc_xac_1 = latest.xuc_xac_1; p.xuc_xac_2 = latest.xuc_xac_2; p.xuc_xac_3 = latest.xuc_xac_3;
      p.tong = latest.tong;
      const ok = p.du_doan === latest.ket_qua;
      p.kq_du_doan = ok ? 'dung' : 'sai';
      if (ok) breakDetectionData.consecutiveWrong = 0;
      else breakDetectionData.consecutiveWrong++;
      updatePatternLearning(p.thuat_toan, ok);
      console.log(`${ok?'✅':'❌'} Phiên #${p.phien}: ${ok?'ĐÚNG':'SAI'} - ${p.du_doan} vs ${latest.ket_qua}`);
      break;
    }
  }
}

async function startLoop() {
  console.log('🚀 Bot dự đoán khởi động...');
  while (true) {
    try {
      await updateResults();
      await new Promise(r=>setTimeout(r, CHECK_INTERVAL));
      await generatePrediction();
      await new Promise(r=>setTimeout(r, WAIT_AFTER_RESULT));
    } catch (e) {
      console.error('❌ Lỗi vòng lặp:', e.message);
      await new Promise(r=>setTimeout(r, 5000));
    }
  }
}

// ── API ──
app.get('/predict', (req, res) => res.json(currentPrediction || { du_doan: 'dang_doi', kq_du_doan: 'dang_doi' }));
app.get('/predict/history', (req, res) => res.json(predictionHistory));
app.get('/predict/stats', (req, res) => {
  const done = predictionHistory.filter(p=>p.kq_du_doan!=='dang_doi');
  const correct = done.filter(p=>p.kq_du_doan==='dung').length;
  res.json({ total: done.length, correct, wrong: done.length-correct, accuracy: done.length>0?((correct/done.length)*100).toFixed(1)+'%':'0%', break_detection: breakDetectionData });
});
app.get('/predict/learning', (req, res) => {
  const stats = {};
  Object.keys(patternLearningData).forEach(k => {
    const d = patternLearningData[k];
    stats[k] = { total: d.total, correct: d.correct, accuracy: d.total>0?((d.correct/d.total)*100).toFixed(1)+'%':'0%', adjustment: d.confidence_adjustment };
  });
  res.json(stats);
});
app.get('/', (req, res) => res.json({ message: 'Bot dự đoán Sun.win', endpoints: ['/predict','/predict/history','/predict/stats','/predict/learning'] }));

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🌐 Server chạy tại http://0.0.0.0:${PORT}`);
  // Load learning data từ JSONBin trước khi chạy
  patternLearningData = await loadLearningDataRemote();
  defaultPatterns.forEach(p => {
    if (!patternLearningData[p])
      patternLearningData[p] = { total: 0, correct: 0, confidence_adjustment: 0, recent_performance: [] };
  });
  startLoop();
});
