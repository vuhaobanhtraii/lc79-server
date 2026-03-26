const WebSocket = require('ws');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname)));
app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });

const PORT = process.env.PORT || 3001;

// ===== WEBSOCKET =====
let lichSu = [];
let currentSessionId = null;
let ws = null, pingInterval = null, reconnectTimeout = null, staleTimer = null;

const WS_URL = "wss://websocket.azhkthg1.net/websocket?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhbW91bnQiOjAsInVzZXJuYW1lIjoiU0NfYXBpc3Vud2luMTIzIn0.hgrRbSV6vnBwJMg9ZFtbx3rRu9mX_hZMZ_m5gMNhkw0";
const WS_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Origin": "https://play.sun.win"
};

const INIT_MSGS = [
  [1,"MiniGame","GM_apivopnha","WangLin",{"info":"{\"ipAddress\":\"14.249.227.107\",\"wsToken\":\"eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiI5ODE5YW5zc3MiLCJib3QiOjAsImlzTWVyY2hhbnQiOmZhbHNlLCJ2ZXJpZmllZEJhbmtBY2NvdW50IjpmYWxzZSwicGxheUV2ZW50TG9iYnkiOmZhbHNlLCJjdXN0b21lcklkIjozMjMyODExNTEsImFmZklkIjoic3VuLndpbiIsImJhbm5lZCI6ZmFsc2UsImJyYW5kIjoiZ2VtIiwidGltZXN0YW1wIjoxNzYzMDMyOTI4NzcwLCJsb2NrR2FtZXMiOltdLCJhbW91bnQiOjAsImxvY2tDaGF0IjpmYWxzZSwicGhvbmVWZXJpZmllZCI6ZmFsc2UsImlwQWRkcmVzcyI6IjE0LjI0OS4yMjcuMTA3IiwibXV0ZSI6ZmFsc2UsImF2YXRhciI6Imh0dHBzOi8vaW1hZ2VzLnN3aW5zaG9wLm5ldC9pbWFnZXMvYXZhdGFyL2F2YXRhcl8wNS5wbmciLCJwbGF0Zm9ybUlkIjo0LCJ1c2VySWQiOiI4ODM4NTMzZS1kZTQzLTRiOGQtOTUwMy02MjFmNDA1MDUzNGUiLCJyZWdUaW1lIjoxNzYxNjMyMzAwNTc2LCJwaG9uZSI6IiIsImRlcG9zaXQiOmZhbHNlLCJ1c2VybmFtZSI6IkdNX2FwaXZvcG5oYSJ9.guH6ztJSPXUL1cU8QdMz8O1Sdy_SbxjSM-CDzWPTr-0\",\"locale\":\"vi\",\"userId\":\"8838533e-de43-4b8d-9503-621f4050534e\",\"username\":\"GM_apivopnha\",\"timestamp\":1763032928770,\"refreshToken\":\"e576b43a64e84f789548bfc7c4c8d1e5.7d4244a361e345908af95ee2e8ab2895\"}","signature":"45EF4B318C883862C36E1B189A1DF5465EBB60CB602BA05FAD8FCBFCD6E0DA8CB3CE65333EDD79A2BB4ABFCE326ED5525C7D971D9DEDB5A17A72764287FFE6F62CBC2DF8A04CD8EFF8D0D5AE27046947ADE45E62E644111EFDE96A74FEC635A97861A425FF2B5732D74F41176703CA10CFEED67D0745FF15EAC1065E1C8BCBFA"}],
  [6,"MiniGame","taixiuPlugin",{cmd:1005}],
  [6,"MiniGame","lobbyPlugin",{cmd:10001}]
];

function connectWS() {
  if (ws) { ws.removeAllListeners(); try { ws.close(); } catch(e){} }
  ws = new WebSocket(WS_URL, { headers: WS_HEADERS });

  ws.on('open', () => {
    console.log('[✅] WebSocket connected');
    INIT_MSGS.forEach((msg, i) => setTimeout(() => { if (ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg)); }, i*600));
    clearInterval(pingInterval);
    pingInterval = setInterval(() => { if (ws.readyState===WebSocket.OPEN) ws.ping(); }, 10000);
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => { console.log('[⚠️] Stale - reconnect'); ws.close(); }, 90000);
  });

  ws.on('pong', () => console.log('[📶] Ping OK'));

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data) || typeof data[1] !== 'object') return;
      const { cmd, sid, d1, d2, d3 } = data[1];

      if (cmd === 1005 && data[1].htr) {
        lichSu = data[1].htr.map(p => {
          const t = p.d1+p.d2+p.d3;
          return { Phien:p.sid, Xuc_xac_1:p.d1, Xuc_xac_2:p.d2, Xuc_xac_3:p.d3, Tong:t, Ket_qua:t>10?'Tài':'Xỉu' };
        }).reverse();
        console.log(`[📋] Lịch sử: ${lichSu.length} phiên`);
        runPrediction();
      }

      if (cmd === 1008 && sid) currentSessionId = sid;

      if (cmd === 1003 && d1 && d2 && d3) {
        clearTimeout(staleTimer);
        staleTimer = setTimeout(() => ws.close(), 90000);
        const t = d1+d2+d3;
        const entry = { Phien:currentSessionId, Xuc_xac_1:d1, Xuc_xac_2:d2, Xuc_xac_3:d3, Tong:t, Ket_qua:t>10?'Tài':'Xỉu' };
        lichSu.unshift(entry);
        if (lichSu.length > 500) lichSu.pop();
        console.log(`[🎲] Phiên ${currentSessionId}: ${d1}-${d2}-${d3}=${t} (${entry.Ket_qua})`);
        currentSessionId = null;
        updateResults();
        setTimeout(runPrediction, 1500);
      }
    } catch(e) { console.error('[❌] WS parse:', e.message); }
  });

  ws.on('close', (code) => {
    console.log(`[🔌] Closed: ${code}`);
    clearInterval(pingInterval); clearTimeout(staleTimer); clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(connectWS, 2500);
  });

  ws.on('error', (e) => { console.error('[❌] WS error:', e.message); try { ws.close(); } catch(_){} });
}

// ===== LEARNING =====
const LEARNING_FILE = './learning.json';
let ld = {};
try { if (fs.existsSync(LEARNING_FILE)) ld = JSON.parse(fs.readFileSync(LEARNING_FILE,'utf8')); } catch(e){}
['cau_bet','cau_dao_1_1','cau_1_2_3','cau_3_2_1','cau_2_2','cau_2_1_2','nhip_nghieng_5','nhip_nghieng_7',
 'gap_thep_martingale','phan_tich_tong','xu_huong_manh','cau_nhay','fibonacci','odd_even_analysis',
 'total_sum_trend','house_intervention'].forEach(p => { if (!ld[p]) ld[p]={total:0,correct:0,adj:0,recent:[]}; });

function saveLD() { try { fs.writeFileSync(LEARNING_FILE, JSON.stringify(ld)); } catch(e){} }

function learn(pattern, ok) {
  const d=ld[pattern]||{total:0,correct:0,adj:0,recent:[]};
  ld[pattern]=d; d.total++; if(ok)d.correct++;
  d.recent.unshift(ok?1:0); if(d.recent.length>20)d.recent.pop();
  const acc=d.correct/d.total;
  let rAcc=acc;
  if(d.recent.length>=5){let ws=0,wt=0;d.recent.forEach((v,i)=>{const w=1/(i+1);ws+=v*w;wt+=w;});rAcc=ws/wt;}
  const f=acc*0.4+rAcc*0.6;
  if(d.total>=3){if(f>=0.75)d.adj=8;else if(f>=0.65)d.adj=5;else if(f>=0.58)d.adj=3;else if(f>=0.52)d.adj=0;else if(f>=0.45)d.adj=-3;else if(f>=0.38)d.adj=-5;else d.adj=-8;}
  if(d.total%5===0)saveLD();
}

function c(p,base){const d=ld[p];return Math.max(55,Math.min(85,base+((d&&d.total>=3)?d.adj:0)));}

// ===== ALGORITHMS =====
const algos = [
  h => { // cauBet
    if(h.length<3)return null; let n=1,last=h[0].Ket_qua;
    for(let i=1;i<Math.min(h.length,20);i++){if(h[i].Ket_qua===last)n++;else break;}
    if(n<3)return null;
    return{pattern:'cau_bet',prediction:n>=6?(last==='Tài'?'Xỉu':'Tài'):last,confidence:c('cau_bet',n>=6?Math.min(62+(n-6)*2,72):56+n),description:`Cầu bệt ${n} phiên ${last}`};
  },
  h => { // cauDao11
    if(h.length<3)return null; let n=0;
    for(let i=0;i<Math.min(h.length-1,10);i++){if(h[i].Ket_qua!==h[i+1].Ket_qua)n++;else break;}
    if(n<3)return null;
    return{pattern:'cau_dao_1_1',prediction:h[0].Ket_qua==='Tài'?'Xỉu':'Tài',confidence:c('cau_dao_1_1',58+Math.min(n-3,5)*2),description:`Cầu đảo 1-1 (${n})`};
  },
  h => { // cau123
    if(h.length<6)return null; const r=h.slice(0,6);
    if(r[0].Ket_qua===r[1].Ket_qua&&r[0].Ket_qua!==r[2].Ket_qua&&r[2].Ket_qua===r[3].Ket_qua&&r[2].Ket_qua===r[4].Ket_qua&&r[2].Ket_qua!==r[5].Ket_qua)
      return{pattern:'cau_1_2_3',prediction:r[2].Ket_qua,confidence:c('cau_1_2_3',63),description:'Cầu 1-2-3'};
    return null;
  },
  h => { // cau321
    if(h.length<6)return null; const r=h.slice(0,6);
    if(r[0].Ket_qua===r[1].Ket_qua&&r[0].Ket_qua===r[2].Ket_qua&&r[0].Ket_qua!==r[3].Ket_qua&&r[3].Ket_qua===r[4].Ket_qua&&r[3].Ket_qua!==r[5].Ket_qua)
      return{pattern:'cau_3_2_1',prediction:r[5].Ket_qua==='Tài'?'Xỉu':'Tài',confidence:c('cau_3_2_1',62),description:'Cầu 3-2-1'};
    return null;
  },
  h => { // cau22
    if(h.length<6)return null; const r=h.slice(0,6);
    if(r[0].Ket_qua===r[1].Ket_qua&&r[0].Ket_qua!==r[2].Ket_qua&&r[2].Ket_qua===r[3].Ket_qua&&r[0].Ket_qua===r[4].Ket_qua&&r[0].Ket_qua===r[5].Ket_qua)
      return{pattern:'cau_2_2',prediction:r[0].Ket_qua==='Tài'?'Xỉu':'Tài',confidence:c('cau_2_2',65),description:'Cầu 2-2 mạnh'};
    if(r[0].Ket_qua===r[1].Ket_qua&&r[0].Ket_qua!==r[2].Ket_qua&&r[2].Ket_qua===r[3].Ket_qua)
      return{pattern:'cau_2_2',prediction:r[2].Ket_qua==='Tài'?'Xỉu':'Tài',confidence:c('cau_2_2',62),description:'Cầu 2-2 hình thành'};
    return null;
  },
  h => { // cau212
    if(h.length<5)return null; const r=h.slice(0,5);
    if(r[0].Ket_qua===r[1].Ket_qua&&r[0].Ket_qua!==r[2].Ket_qua&&r[2].Ket_qua!==r[3].Ket_qua&&r[3].Ket_qua===r[4].Ket_qua&&r[0].Ket_qua===r[3].Ket_qua)
      return{pattern:'cau_2_1_2',prediction:r[0].Ket_qua==='Tài'?'Xỉu':'Tài',confidence:c('cau_2_1_2',64),description:'Cầu 2-1-2'};
    return null;
  },
  h => { // nghieng5
    if(h.length<5)return null; const tai=h.slice(0,5).filter(x=>x.Ket_qua==='Tài').length;
    if(tai===4)return{pattern:'nhip_nghieng_5',prediction:'Tài',confidence:c('nhip_nghieng_5',61),description:'Nhịp nghiêng 5: 4/5 Tài'};
    if(tai===1)return{pattern:'nhip_nghieng_5',prediction:'Xỉu',confidence:c('nhip_nghieng_5',61),description:'Nhịp nghiêng 5: 4/5 Xỉu'};
    return null;
  },
  h => { // nghieng7
    if(h.length<7)return null; const tai=h.slice(0,7).filter(x=>x.Ket_qua==='Tài').length,xiu=7-tai;
    if(tai>=5)return{pattern:'nhip_nghieng_7',prediction:'Tài',confidence:c('nhip_nghieng_7',64+(tai-5)*2),description:`Nhịp nghiêng 7: ${tai}/7 Tài`};
    if(xiu>=5)return{pattern:'nhip_nghieng_7',prediction:'Xỉu',confidence:c('nhip_nghieng_7',64+(xiu-5)*2),description:`Nhịp nghiêng 7: ${xiu}/7 Xỉu`};
    return null;
  },
  h => { // phanTichTong
    if(h.length<5)return null; const t=h.slice(0,5).map(x=>parseInt(x.Tong)).filter(t=>!isNaN(t));
    if(t.length!==5)return null; const avg=t.reduce((a,b)=>a+b,0)/5;
    if(avg>=12)return{pattern:'phan_tich_tong',prediction:'Tài',confidence:c('phan_tich_tong',59),description:`TB tổng: ${avg.toFixed(1)}`};
    if(avg<=9)return{pattern:'phan_tich_tong',prediction:'Xỉu',confidence:c('phan_tich_tong',59),description:`TB tổng: ${avg.toFixed(1)}`};
    return null;
  },
  h => { // xuHuong
    if(h.length<15)return null; const tai=h.slice(0,15).filter(x=>x.Ket_qua==='Tài').length,xiu=15-tai;
    if(tai>=11)return{pattern:'xu_huong_manh',prediction:'Tài',confidence:c('xu_huong_manh',66+(tai-11)*2),description:`Xu hướng: ${tai}/15 Tài`};
    if(xiu>=11)return{pattern:'xu_huong_manh',prediction:'Xỉu',confidence:c('xu_huong_manh',66+(xiu-11)*2),description:`Xu hướng: ${xiu}/15 Xỉu`};
    return null;
  },
  h => { // cauNhay
    if(h.length<10)return null; let n=0;
    for(let i=0;i<9;i++)if(h[i].Ket_qua!==h[i+1].Ket_qua)n++;
    if(n>=7)return{pattern:'cau_nhay',prediction:h[0].Ket_qua==='Tài'?'Xỉu':'Tài',confidence:c('cau_nhay',58),description:`Cầu nhảy: ${n}/9`};
    return null;
  },
  h => { // gapThep
    if(h.length<5)return null; let n=1,last=h[0].Ket_qua;
    for(let i=1;i<Math.min(h.length,15);i++){if(h[i].Ket_qua===last)n++;else break;}
    if(n<2)return null;
    return{pattern:'gap_thep_martingale',prediction:last,confidence:c('gap_thep_martingale',Math.min(57+(n-2)*2,70)),description:`Gấp thếp: ${n} phiên ${last}`};
  },
  h => { // fibonacci
    if(h.length<10)return null; const tP=[],xP=[];
    h.slice(0,10).forEach((x,i)=>x.Ket_qua==='Tài'?tP.push(i):xP.push(i));
    const chk=pos=>{if(pos.length<3)return false;const g=[];for(let i=1;i<pos.length;i++)g.push(pos[i]-pos[i-1]);return g.length>=2&&Math.abs(g[g.length-1]-g[g.length-2])<=2;};
    if(chk(tP))return{pattern:'fibonacci',prediction:'Tài',confidence:c('fibonacci',60),description:'Fibonacci - Tài'};
    if(chk(xP))return{pattern:'fibonacci',prediction:'Xỉu',confidence:c('fibonacci',60),description:'Fibonacci - Xỉu'};
    return null;
  },
  h => { // oddEven
    if(h.length<8)return null; let chan=0,le=0;
    h.slice(0,8).forEach(x=>{const t=parseInt(x.Tong);if(!isNaN(t))t%2===0?chan++:le++;});
    if(chan>=6)return{pattern:'odd_even_analysis',prediction:'Tài',confidence:c('odd_even_analysis',59),description:`Tổng chẵn: ${chan}/8`};
    if(le>=6)return{pattern:'odd_even_analysis',prediction:'Xỉu',confidence:c('odd_even_analysis',59),description:`Tổng lẻ: ${le}/8`};
    return null;
  },
  h => { // sumTrend
    if(h.length<6)return null; const t=h.slice(0,6).map(x=>parseInt(x.Tong)).filter(t=>!isNaN(t));
    if(t.length!==6)return null; let inc=0,dec=0;
    for(let i=1;i<t.length;i++){if(t[i]>t[i-1])inc++;if(t[i]<t[i-1])dec++;}
    if(inc>=4)return{pattern:'total_sum_trend',prediction:'Tài',confidence:c('total_sum_trend',61),description:`Tổng tăng: ${inc}/5`};
    if(dec>=4)return{pattern:'total_sum_trend',prediction:'Xỉu',confidence:c('total_sum_trend',61),description:`Tổng giảm: ${dec}/5`};
    return null;
  }
];

function houseDetect(h, preds) {
  if(h.length<20||preds.length<10)return null;
  let score=0; const signals=[];
  const extremes=h.slice(0,20).map(x=>parseInt(x.Tong)).filter(t=>!isNaN(t)&&(t<=4||t>=17));
  if(extremes.length>=5){score+=25;signals.push(`Tổng cực đoan ${extremes.length}/20`);}
  const recent=preds.filter(p=>p.kq!=='dang_doi').slice(0,10);
  if(recent.length>=8){const wr=recent.filter(p=>p.kq==='sai').length/recent.length*100;if(wr>=70){score+=35;signals.push(`Tỷ lệ sai: ${wr.toFixed(0)}%`);}}
  const tai10=h.slice(0,10).filter(r=>r.Ket_qua==='Tài').length;
  if(tai10>=9||(10-tai10)>=9){score+=20;signals.push('Mất cân bằng nghiêm trọng');}
  if(score<50)return null;
  return{pattern:'house_intervention',prediction:h[0].Ket_qua==='Tài'?'Xỉu':'Tài',confidence:c('house_intervention',Math.min(58+score/8,72)),description:`Can thiệp nhà cái (${score}đ)`,intervention_signals:signals};
}

function detectBreak(h, preds) {
  const signals=[]; let prob=0;
  if(cWrong>=5){signals.push(`${cWrong} lần sai liên tiếp`);prob+=30;}
  if(cWrong>=3)prob+=18;
  const r10=preds.filter(p=>p.kq!=='dang_doi').slice(0,10);
  if(r10.length>=10){const acc=r10.filter(p=>p.kq==='dung').length/10*100;if(acc<35){signals.push(`Chính xác: ${acc.toFixed(0)}%`);prob+=25;}else if(acc<50){signals.push(`Chính xác thấp: ${acc.toFixed(0)}%`);prob+=15;}}
  if(h.length>=5&&h.slice(0,5).every(r=>r.Ket_qua===h[0].Ket_qua)){signals.push('5 phiên liên tiếp cùng kết quả');prob+=18;}
  if(h.length>=8){const t8=h.slice(0,8).filter(r=>r.Ket_qua==='Tài').length;if(t8>=7||(8-t8)>=7){signals.push('Mất cân bằng 8 phiên');prob+=12;}}
  prob=Math.min(prob,98);
  let risk='safe',rec='✅ AN TOÀN';
  if(prob>=65){risk='critical';rec='🛑 DỪNG NGAY';}
  else if(prob>=50){risk='high';rec='⛔ NGUY HIỂM - Tạm dừng';}
  else if(prob>=35){risk='medium';rec='⚠️ CẢNH BÁO - Giảm cược';}
  else if(prob>=20){risk='low_warning';rec='⚡ CHÚ Ý - Thận trọng';}
  return{risk_level:risk,break_probability:prob,suspicious_signals:signals,recommendation:rec};
}

// ===== PREDICTION ENGINE =====
let currentPrediction = null;
let predictionHistory = [];
let lastProcessedPhien = null;
let cWrong = 0;

function updateResults() {
  if(lichSu.length===0)return;
  const latest=lichSu[0];
  for(let p of predictionHistory){
    if(p.phien===latest.Phien.toString()&&p.kq==='dang_doi'){
      p.ket_qua=latest.Ket_qua;
      p.xuc_xac=`${latest.Xuc_xac_1}-${latest.Xuc_xac_2}-${latest.Xuc_xac_3}`;
      p.tong=latest.Tong.toString();
      const ok=p.du_doan===latest.Ket_qua;
      p.kq=ok?'dung':'sai';
      learn(p.thuat_toan,ok);
      if(ok)cWrong=0;else cWrong++;
      console.log(`${ok?'✅':'❌'} Phiên #${p.phien}: ${ok?'ĐÚNG':'SAI'} - Dự đoán ${p.du_doan}, thực tế ${latest.Ket_qua}`);
      break;
    }
  }
}

function runPrediction() {
  if(lichSu.length===0)return;
  const currentPhien=lichSu[0].Phien;
  if(currentPhien===lastProcessedPhien)return;

  const house=houseDetect(lichSu,predictionHistory);
  const preds=algos.map(fn=>fn(lichSu)).filter(Boolean);
  if(house)preds.push(house);
  if(preds.length===0){lastProcessedPhien=currentPhien;return;}

  preds.sort((a,b)=>b.confidence-a.confidence);
  const best=preds[0];
  const taiV=preds.filter(p=>p.prediction==='Tài').length;
  const xiuV=preds.filter(p=>p.prediction==='Xỉu').length;
  let fp=best.prediction,fc=best.confidence;
  if(preds.length>=3){if(taiV>xiuV*2){fp='Tài';fc=Math.min(fc+2,85);}else if(xiuV>taiV*2){fp='Xỉu';fc=Math.min(fc+2,85);}}
  fc=Math.max(55,Math.min(85,fc));

  const brk=detectBreak(lichSu,predictionHistory);
  const nextPhien=currentPhien+1;

  const newPred={
    phien:nextPhien.toString(), du_doan:fp, ti_le:fc.toFixed(0)+'%',
    thuat_toan:best.pattern, mo_ta:best.description,
    so_pattern:preds.length, tai_votes:taiV, xiu_votes:xiuV,
    top_patterns:preds.slice(0,5).map(p=>({pattern:p.pattern,prediction:p.prediction,confidence:p.confidence.toFixed(0)+'%',description:p.description})),
    break_detection:{risk_level:brk.risk_level,break_probability:brk.break_probability+'%',recommendation:brk.recommendation,signals:brk.suspicious_signals},
    house_intervention:house?{detected:true,confidence:house.confidence.toFixed(0)+'%',signals:house.intervention_signals}:{detected:false},
    kq:'dang_doi', ket_qua:'---', xuc_xac:'---', tong:'---',
    timestamp:new Date().toISOString()
  };

  currentPrediction=newPred;
  predictionHistory.unshift(newPred);
  if(predictionHistory.length>500)predictionHistory=predictionHistory.slice(0,500);
  lastProcessedPhien=currentPhien;
  console.log(`🎲 Phiên #${nextPhien}: ${fp} (${fc.toFixed(0)}%) | ${best.pattern} | Tài:${taiV} Xỉu:${xiuV}`);
}

// ===== API =====
app.get('/api/prediction', (req,res) => res.json(currentPrediction||{phien:'0',du_doan:'dang_doi',ti_le:'0%',kq:'dang_doi'}));
app.get('/api/prediction-history', (req,res) => res.json(predictionHistory));
app.get('/api/lichsu', (req,res) => res.json(lichSu));
app.get('/api/stats', (req,res) => {
  const last20=lichSu.slice(0,20);
  const tai=last20.filter(x=>x.Ket_qua==='Tài').length;
  const done=predictionHistory.filter(p=>p.kq!=='dang_doi');
  const correct=done.filter(p=>p.kq==='dung').length;
  res.json({
    last20:{tai,xiu:last20.length-tai,total:last20.length},
    accuracy:{total:done.length,correct,wrong:done.length-correct,rate:done.length>0?((correct/done.length)*100).toFixed(1)+'%':'0%'},
    currentPrediction, consecutiveWrong:cWrong
  });
});
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'index.html')));

// ===== START =====
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Server: http://0.0.0.0:${PORT}`);
  connectWS();
});
