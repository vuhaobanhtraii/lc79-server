const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname)));
app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });

const PORT = process.env.PORT || 5000;
const SOURCE_API = process.env.SOURCE_API || 'https://lc79-server-production.up.railway.app';

// ===== CACHE =====
let lichSu = [];
let lastFetch = 0;
const CACHE_TTL = 2000;

async function fetchHistory() {
  const now = Date.now();
  if (lichSu.length > 0 && (now - lastFetch) < CACHE_TTL) return lichSu;
  try {
    const res = await axios.get(SOURCE_API + '/api/lichsu', { timeout: 5000 });
    if (Array.isArray(res.data)) {
      lichSu = res.data.slice(0, 500);
      lastFetch = now;
    }
  } catch (e) { console.error('❌ Fetch lỗi:', e.message); }
  return lichSu;
}

// ===== LEARNING =====
const LEARNING_FILE = './learning.json';
let learningData = {};
try { if (fs.existsSync(LEARNING_FILE)) learningData = JSON.parse(fs.readFileSync(LEARNING_FILE, 'utf8')); } catch (e) {}

const PATTERNS = ['cau_bet','cau_dao_1_1','cau_1_2_3','cau_3_2_1','cau_2_2','cau_2_1_2',
  'nhip_nghieng_5','nhip_nghieng_7','gap_thep_martingale','phan_tich_tong','phan_tich_xuc_xac',
  'xu_huong_manh','cau_nhay','fibonacci','odd_even_analysis','total_sum_trend','house_intervention'];
PATTERNS.forEach(p => { if (!learningData[p]) learningData[p] = { total:0, correct:0, adj:0, recent:[] }; });

function saveLearning() { try { fs.writeFileSync(LEARNING_FILE, JSON.stringify(learningData)); } catch(e){} }

function learnPattern(pattern, ok) {
  const d = learningData[pattern];
  d.total++; if (ok) d.correct++;
  d.recent.unshift(ok?1:0); if (d.recent.length > 20) d.recent.pop();
  const acc = d.correct / d.total;
  let rAcc = acc;
  if (d.recent.length >= 5) {
    let ws=0,wt=0; d.recent.forEach((v,i)=>{const w=1/(i+1);ws+=v*w;wt+=w;}); rAcc=ws/wt;
  }
  const f = acc*0.4 + rAcc*0.6;
  if (d.total>=3) { if(f>=0.75)d.adj=8; else if(f>=0.65)d.adj=5; else if(f>=0.58)d.adj=3; else if(f>=0.52)d.adj=0; else if(f>=0.45)d.adj=-3; else if(f>=0.38)d.adj=-5; else d.adj=-8; }
  if (d.total%5===0) saveLearning();
}

function conf(pattern, base) {
  const d = learningData[pattern];
  return Math.max(55, Math.min(85, base + ((d&&d.total>=3)?d.adj:0)));
}

// ===== ALGORITHMS =====
function cauBet(h) {
  if (h.length<3) return null;
  let n=1, last=h[0].Ket_qua;
  for (let i=1;i<Math.min(h.length,20);i++) { if(h[i].Ket_qua===last)n++; else break; }
  if (n<3) return null;
  const pred = n>=6 ? (last==='Tài'?'Xỉu':'Tài') : last;
  const base = n>=6 ? Math.min(62+(n-6)*2,72) : 56+n;
  return { pattern:'cau_bet', prediction:pred, confidence:conf('cau_bet',base), description:`Cầu bệt ${n} phiên ${last}` };
}

function cauDao11(h) {
  if (h.length<3) return null;
  let n=0;
  for (let i=0;i<Math.min(h.length-1,10);i++) { if(h[i].Ket_qua!==h[i+1].Ket_qua)n++; else break; }
  if (n<3) return null;
  return { pattern:'cau_dao_1_1', prediction:h[0].Ket_qua==='Tài'?'Xỉu':'Tài', confidence:conf('cau_dao_1_1',58+Math.min(n-3,5)*2), description:`Cầu đảo 1-1 (${n} lần)` };
}

function cau123(h) {
  if (h.length<6) return null;
  const r=h.slice(0,6);
  if (r[0].Ket_qua===r[1].Ket_qua&&r[0].Ket_qua!==r[2].Ket_qua&&r[2].Ket_qua===r[3].Ket_qua&&r[2].Ket_qua===r[4].Ket_qua&&r[2].Ket_qua!==r[5].Ket_qua)
    return { pattern:'cau_1_2_3', prediction:r[2].Ket_qua, confidence:conf('cau_1_2_3',63), description:'Cầu 1-2-3' };
  return null;
}

function cau321(h) {
  if (h.length<6) return null;
  const r=h.slice(0,6);
  if (r[0].Ket_qua===r[1].Ket_qua&&r[0].Ket_qua===r[2].Ket_qua&&r[0].Ket_qua!==r[3].Ket_qua&&r[3].Ket_qua===r[4].Ket_qua&&r[3].Ket_qua!==r[5].Ket_qua)
    return { pattern:'cau_3_2_1', prediction:r[5].Ket_qua==='Tài'?'Xỉu':'Tài', confidence:conf('cau_3_2_1',62), description:'Cầu 3-2-1' };
  return null;
}

function cau22(h) {
  if (h.length<6) return null;
  const r=h.slice(0,6);
  if (r[0].Ket_qua===r[1].Ket_qua&&r[0].Ket_qua!==r[2].Ket_qua&&r[2].Ket_qua===r[3].Ket_qua&&r[0].Ket_qua===r[4].Ket_qua&&r[0].Ket_qua===r[5].Ket_qua)
    return { pattern:'cau_2_2', prediction:r[0].Ket_qua==='Tài'?'Xỉu':'Tài', confidence:conf('cau_2_2',65), description:'Cầu 2-2 mạnh' };
  if (r[0].Ket_qua===r[1].Ket_qua&&r[0].Ket_qua!==r[2].Ket_qua&&r[2].Ket_qua===r[3].Ket_qua)
    return { pattern:'cau_2_2', prediction:r[2].Ket_qua==='Tài'?'Xỉu':'Tài', confidence:conf('cau_2_2',62), description:'Cầu 2-2 hình thành' };
  return null;
}

function cau212(h) {
  if (h.length<5) return null;
  const r=h.slice(0,5);
  if (r[0].Ket_qua===r[1].Ket_qua&&r[0].Ket_qua!==r[2].Ket_qua&&r[2].Ket_qua!==r[3].Ket_qua&&r[3].Ket_qua===r[4].Ket_qua&&r[0].Ket_qua===r[3].Ket_qua)
    return { pattern:'cau_2_1_2', prediction:r[0].Ket_qua==='Tài'?'Xỉu':'Tài', confidence:conf('cau_2_1_2',64), description:'Cầu 2-1-2' };
  return null;
}

function nghieng5(h) {
  if (h.length<5) return null;
  const tai=h.slice(0,5).filter(x=>x.Ket_qua==='Tài').length;
  if (tai===4) return { pattern:'nhip_nghieng_5', prediction:'Tài', confidence:conf('nhip_nghieng_5',61), description:'Nhịp nghiêng 5: 4/5 Tài' };
  if (tai===1) return { pattern:'nhip_nghieng_5', prediction:'Xỉu', confidence:conf('nhip_nghieng_5',61), description:'Nhịp nghiêng 5: 4/5 Xỉu' };
  return null;
}

function nghieng7(h) {
  if (h.length<7) return null;
  const tai=h.slice(0,7).filter(x=>x.Ket_qua==='Tài').length, xiu=7-tai;
  if (tai>=5) return { pattern:'nhip_nghieng_7', prediction:'Tài', confidence:conf('nhip_nghieng_7',64+(tai-5)*2), description:`Nhịp nghiêng 7: ${tai}/7 Tài` };
  if (xiu>=5) return { pattern:'nhip_nghieng_7', prediction:'Xỉu', confidence:conf('nhip_nghieng_7',64+(xiu-5)*2), description:`Nhịp nghiêng 7: ${xiu}/7 Xỉu` };
  return null;
}

function phanTichTong(h) {
  if (h.length<5) return null;
  const totals=h.slice(0,5).map(x=>parseInt(x.Tong)).filter(t=>!isNaN(t));
  if (totals.length!==5) return null;
  const avg=totals.reduce((a,b)=>a+b,0)/5;
  if (avg>=12) return { pattern:'phan_tich_tong', prediction:'Tài', confidence:conf('phan_tich_tong',59), description:`TB tổng: ${avg.toFixed(1)}` };
  if (avg<=9) return { pattern:'phan_tich_tong', prediction:'Xỉu', confidence:conf('phan_tich_tong',59), description:`TB tổng: ${avg.toFixed(1)}` };
  return null;
}

function xuHuong(h) {
  if (h.length<15) return null;
  const tai=h.slice(0,15).filter(x=>x.Ket_qua==='Tài').length, xiu=15-tai;
  if (tai>=11) return { pattern:'xu_huong_manh', prediction:'Tài', confidence:conf('xu_huong_manh',66+(tai-11)*2), description:`Xu hướng: ${tai}/15 Tài` };
  if (xiu>=11) return { pattern:'xu_huong_manh', prediction:'Xỉu', confidence:conf('xu_huong_manh',66+(xiu-11)*2), description:`Xu hướng: ${xiu}/15 Xỉu` };
  return null;
}

function cauNhay(h) {
  if (h.length<10) return null;
  let n=0; for(let i=0;i<9;i++) if(h[i].Ket_qua!==h[i+1].Ket_qua)n++;
  if (n>=7) return { pattern:'cau_nhay', prediction:h[0].Ket_qua==='Tài'?'Xỉu':'Tài', confidence:conf('cau_nhay',58), description:`Cầu nhảy: ${n}/9` };
  return null;
}

function gapThep(h) {
  if (h.length<5) return null;
  let n=1, last=h[0].Ket_qua;
  for(let i=1;i<Math.min(h.length,15);i++){if(h[i].Ket_qua===last)n++;else break;}
  if (n<2) return null;
  return { pattern:'gap_thep_martingale', prediction:last, confidence:conf('gap_thep_martingale',Math.min(57+(n-2)*2,70)), description:`Gấp thếp: ${n} phiên ${last}` };
}

function fibonacci(h) {
  if (h.length<10) return null;
  const tP=[],xP=[];
  h.slice(0,10).forEach((x,i)=>x.Ket_qua==='Tài'?tP.push(i):xP.push(i));
  const chk=pos=>{if(pos.length<3)return false;const g=[];for(let i=1;i<pos.length;i++)g.push(pos[i]-pos[i-1]);return g.length>=2&&Math.abs(g[g.length-1]-g[g.length-2])<=2;};
  if (chk(tP)) return { pattern:'fibonacci', prediction:'Tài', confidence:conf('fibonacci',60), description:'Fibonacci - Tài' };
  if (chk(xP)) return { pattern:'fibonacci', prediction:'Xỉu', confidence:conf('fibonacci',60), description:'Fibonacci - Xỉu' };
  return null;
}

function oddEven(h) {
  if (h.length<8) return null;
  let chan=0,le=0; h.slice(0,8).forEach(x=>{const t=parseInt(x.Tong);if(!isNaN(t))t%2===0?chan++:le++;});
  if (chan>=6) return { pattern:'odd_even_analysis', prediction:'Tài', confidence:conf('odd_even_analysis',59), description:`Tổng chẵn: ${chan}/8` };
  if (le>=6) return { pattern:'odd_even_analysis', prediction:'Xỉu', confidence:conf('odd_even_analysis',59), description:`Tổng lẻ: ${le}/8` };
  return null;
}

function sumTrend(h) {
  if (h.length<6) return null;
  const t=h.slice(0,6).map(x=>parseInt(x.Tong)).filter(t=>!isNaN(t));
  if (t.length!==6) return null;
  let inc=0,dec=0; for(let i=1;i<t.length;i++){if(t[i]>t[i-1])inc++;if(t[i]<t[i-1])dec++;}
  if (inc>=4) return { pattern:'total_sum_trend', prediction:'Tài', confidence:conf('total_sum_trend',61), description:`Tổng tăng: ${inc}/5` };
  if (dec>=4) return { pattern:'total_sum_trend', prediction:'Xỉu', confidence:conf('total_sum_trend',61), description:`Tổng giảm: ${dec}/5` };
  return null;
}

function houseIntervention(h, preds) {
  if (h.length<20||preds.length<10) return null;
  let score=0; const signals=[];
  const extremes=h.slice(0,20).map(x=>parseInt(x.Tong)).filter(t=>!isNaN(t)&&(t<=4||t>=17));
  if (extremes.length>=5){score+=25;signals.push(`Tổng cực đoan ${extremes.length}/20`);}
  const recent=preds.filter(p=>p.kq!=='dang_doi').slice(0,10);
  if (recent.length>=8){const wr=recent.filter(p=>p.kq==='sai').length/recent.length*100;if(wr>=70){score+=35;signals.push(`Tỷ lệ sai: ${wr.toFixed(0)}%`);}}
  const tai10=h.slice(0,10).filter(r=>r.Ket_qua==='Tài').length;
  if (tai10>=9||(10-tai10)>=9){score+=20;signals.push('Mất cân bằng nghiêm trọng');}
  if (score<50) return null;
  return { pattern:'house_intervention', prediction:h[0].Ket_qua==='Tài'?'Xỉu':'Tài', confidence:conf('house_intervention',Math.min(58+score/8,72)), description:`Can thiệp nhà cái (${score}đ)`, intervention_signals:signals };
}

// ===== PREDICTION STATE =====
let currentPrediction = null;
let predictionHistory = [];
let lastProcessedPhien = null;
let consecutiveWrong = 0;

function detectBreak(h, preds) {
  const signals=[]; let prob=0;
  if (consecutiveWrong>=5){signals.push(`${consecutiveWrong} lần sai liên tiếp`);prob+=30;}
  if (consecutiveWrong>=3) prob+=18;
  const r10=preds.filter(p=>p.kq!=='dang_doi').slice(0,10);
  if (r10.length>=10){const acc=r10.filter(p=>p.kq==='dung').length/10*100;if(acc<35){signals.push(`Độ chính xác: ${acc.toFixed(0)}%`);prob+=25;}else if(acc<50){signals.push(`Chính xác thấp: ${acc.toFixed(0)}%`);prob+=15;}}
  if (h.length>=5&&h.slice(0,5).every(r=>r.Ket_qua===h[0].Ket_qua)){signals.push('5 phiên liên tiếp cùng kết quả');prob+=18;}
  if (h.length>=8){const t8=h.slice(0,8).filter(r=>r.Ket_qua==='Tài').length;if(t8>=7||(8-t8)>=7){signals.push('Mất cân bằng 8 phiên');prob+=12;}}
  prob=Math.min(prob,98);
  let risk='safe', rec='✅ AN TOÀN';
  if(prob>=65){risk='critical';rec='🛑 DỪNG NGAY';}
  else if(prob>=50){risk='high';rec='⛔ NGUY HIỂM - Tạm dừng';}
  else if(prob>=35){risk='medium';rec='⚠️ CẢNH BÁO - Giảm cược';}
  else if(prob>=20){risk='low_warning';rec='⚡ CHÚ Ý - Thận trọng';}
  return { risk_level:risk, break_probability:prob, suspicious_signals:signals, recommendation:rec };
}

async function runPrediction() {
  try {
    const h = await fetchHistory();
    if (h.length===0) return;
    const currentPhien = h[0].Phien;
    if (currentPhien===lastProcessedPhien) return;

    // Update result of previous prediction
    for (let p of predictionHistory) {
      if (p.phien===currentPhien.toString() && p.kq==='dang_doi') {
        p.ket_qua = h[0].Ket_qua;
        p.xuc_xac = `${h[0].Xuc_xac_1}-${h[0].Xuc_xac_2}-${h[0].Xuc_xac_3}`;
        p.tong = h[0].Tong.toString();
        const ok = p.du_doan===h[0].Ket_qua;
        p.kq = ok ? 'dung' : 'sai';
        learnPattern(p.thuat_toan, ok);
        if (ok) consecutiveWrong=0; else consecutiveWrong++;
        console.log(`${ok?'✅':'❌'} Phiên #${p.phien}: ${ok?'ĐÚNG':'SAI'} - Dự đoán ${p.du_doan}, thực tế ${h[0].Ket_qua}`);
        break;
      }
    }

    const house = houseIntervention(h, predictionHistory);
    const algos = [cauBet,cauDao11,cau123,cau321,cau22,cau212,nghieng5,nghieng7,phanTichTong,xuHuong,cauNhay,gapThep,fibonacci,oddEven,sumTrend];
    const preds = algos.map(fn=>fn(h)).filter(Boolean);
    if (house) preds.push(house);
    if (preds.length===0) { lastProcessedPhien=currentPhien; return; }

    preds.sort((a,b)=>b.confidence-a.confidence);
    const best=preds[0];
    const taiV=preds.filter(p=>p.prediction==='Tài').length;
    const xiuV=preds.filter(p=>p.prediction==='Xỉu').length;
    let finalPred=best.prediction, finalConf=best.confidence;
    if (preds.length>=3){if(taiV>xiuV*2){finalPred='Tài';finalConf=Math.min(finalConf+2,85);}else if(xiuV>taiV*2){finalPred='Xỉu';finalConf=Math.min(finalConf+2,85);}}
    finalConf=Math.max(55,Math.min(85,finalConf));

    const brk=detectBreak(h, predictionHistory);
    const nextPhien=currentPhien+1;

    const newPred = {
      phien: nextPhien.toString(),
      du_doan: finalPred,
      ti_le: finalConf.toFixed(0)+'%',
      thuat_toan: best.pattern,
      mo_ta: best.description,
      so_pattern: preds.length,
      tai_votes: taiV,
      xiu_votes: xiuV,
      top_patterns: preds.slice(0,5).map(p=>({pattern:p.pattern,prediction:p.prediction,confidence:p.confidence.toFixed(0)+'%',description:p.description})),
      break_detection: { risk_level:brk.risk_level, break_probability:brk.break_probability+'%', recommendation:brk.recommendation, signals:brk.suspicious_signals },
      house_intervention: house ? { detected:true, confidence:house.confidence.toFixed(0)+'%', signals:house.intervention_signals } : { detected:false },
      kq: 'dang_doi', ket_qua:'---', xuc_xac:'---', tong:'---',
      timestamp: new Date().toISOString()
    };

    currentPrediction=newPred;
    predictionHistory.unshift(newPred);
    if (predictionHistory.length>500) predictionHistory=predictionHistory.slice(0,500);
    lastProcessedPhien=currentPhien;
    console.log(`🎲 Phiên #${nextPhien}: ${finalPred} (${finalConf.toFixed(0)}%) | ${best.pattern} | Tài:${taiV} Xỉu:${xiuV}`);
  } catch(e) { console.error('❌ runPrediction:', e.message); }
}

// ===== LOOP =====
setInterval(runPrediction, 3000);
runPrediction();

// ===== API =====
app.get('/api/prediction', (req,res) => res.json(currentPrediction || { phien:'0', du_doan:'dang_doi', ti_le:'0%', kq:'dang_doi' }));
app.get('/api/prediction-history', (req,res) => res.json(predictionHistory));
app.get('/api/lichsu', async (req,res) => res.json(await fetchHistory()));
app.get('/api/stats', async (req,res) => {
  const h=await fetchHistory();
  const last20=h.slice(0,20);
  const tai=last20.filter(x=>x.Ket_qua==='Tài').length;
  const done=predictionHistory.filter(p=>p.kq!=='dang_doi');
  const correct=done.filter(p=>p.kq==='dung').length;
  res.json({
    last20:{tai,xiu:last20.length-tai,total:last20.length},
    accuracy:{total:done.length,correct,wrong:done.length-correct,rate:done.length>0?((correct/done.length)*100).toFixed(1)+'%':'0%'},
    currentPrediction,
    consecutiveWrong
  });
});
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Server: http://0.0.0.0:${PORT}`);
  console.log(`📡 Nguồn: ${SOURCE_API}`);
});
