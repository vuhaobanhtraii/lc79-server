const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3001;

let apiResponseData = {
    "Phien": null,
    "Xuc_xac_1": null,
    "Xuc_xac_2": null,
    "Xuc_xac_3": null,
    "Tong": null,
    "Ket_qua": "",
    "id": "@tiendataox"
};

let lichSu = [];
let currentSessionId = null;

const WEBSOCKET_URL = "wss://websocket.azhkthg1.net/websocket?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhbW91bnQiOjAsInVzZXJuYW1lIjoiU0NfYXBpc3Vud2luMTIzIn0.hgrRbSV6vnBwJMg9ZFtbx3rRu9mX_hZMZ_m5gMNhkw0";
const WS_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Origin": "https://play.sun.win"
};
const RECONNECT_DELAY = 2500;
const PING_INTERVAL = 10000;
const STALE_TIMEOUT = 90000; // reconnect nếu 90s không có phiên mới

let lastDataTime = Date.now();
let staleTimer = null;

const initialMessages = [
    [
        1,
        "MiniGame",
        "GM_apivopnha",
        "WangLin",
        {
            "info": "{\"ipAddress\":\"14.249.227.107\",\"wsToken\":\"eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiI5ODE5YW5zc3MiLCJib3QiOjAsImlzTWVyY2hhbnQiOmZhbHNlLCJ2ZXJpZmllZEJhbmtBY2NvdW50IjpmYWxzZSwicGxheUV2ZW50TG9iYnkiOmZhbHNlLCJjdXN0b21lcklkIjozMjMyODExNTEsImFmZklkIjoic3VuLndpbiIsImJhbm5lZCI6ZmFsc2UsImJyYW5kIjoiZ2VtIiwidGltZXN0YW1wIjoxNzYzMDMyOTI4NzcwLCJsb2NrR2FtZXMiOltdLCJhbW91bnQiOjAsImxvY2tDaGF0IjpmYWxzZSwicGhvbmVWZXJpZmllZCI6ZmFsc2UsImlwQWRkcmVzcyI6IjE0LjI0OS4yMjcuMTA3IiwibXV0ZSI6ZmFsc2UsImF2YXRhciI6Imh0dHBzOi8vaW1hZ2VzLnN3aW5zaG9wLm5ldC9pbWFnZXMvYXZhdGFyL2F2YXRhcl8wNS5wbmciLCJwbGF0Zm9ybUlkIjo0LCJ1c2VySWQiOiI4ODM4NTMzZS1kZTQzLTRiOGQtOTUwMy02MjFmNDA1MDUzNGUiLCJyZWdUaW1lIjoxNzYxNjMyMzAwNTc2LCJwaG9uZSI6IiIsImRlcG9zaXQiOmZhbHNlLCJ1c2VybmFtZSI6IkdNX2FwaXZvcG5oYSJ9.guH6ztJSPXUL1cU8QdMz8O1Sdy_SbxjSM-CDzWPTr-0\",\"locale\":\"vi\",\"userId\":\"8838533e-de43-4b8d-9503-621f4050534e\",\"username\":\"GM_apivopnha\",\"timestamp\":1763032928770,\"refreshToken\":\"e576b43a64e84f789548bfc7c4c8d1e5.7d4244a361e345908af95ee2e8ab2895\"}",
            "signature": "45EF4B318C883862C36E1B189A1DF5465EBB60CB602BA05FAD8FCBFCD6E0DA8CB3CE65333EDD79A2BB4ABFCE326ED5525C7D971D9DEDB5A17A72764287FFE6F62CBC2DF8A04CD8EFF8D0D5AE27046947ADE45E62E644111EFDE96A74FEC635A97861A425FF2B5732D74F41176703CA10CFEED67D0745FF15EAC1065E1C8BCBFA"
        }
    ],
    [6, "MiniGame", "taixiuPlugin", { cmd: 1005 }],
    [6, "MiniGame", "lobbyPlugin", { cmd: 10001 }]
];

let ws = null;
let pingInterval = null;
let reconnectTimeout = null;

function connectWebSocket() {
    if (ws) {
        ws.removeAllListeners();
        ws.close();
    }

    ws = new WebSocket(WEBSOCKET_URL, { headers: WS_HEADERS });

    ws.on('open', () => {
        console.log('[✅] WebSocket connected.');
        initialMessages.forEach((msg, i) => {
            setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(msg));
                }
            }, i * 600);
        });

        clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }, PING_INTERVAL);

        // Reset stale timer
        clearTimeout(staleTimer);
        staleTimer = setTimeout(() => {
            console.log('[⚠️] Không có dữ liệu 90s — reconnect...');
            if (ws) ws.close();
        }, STALE_TIMEOUT);
    });

    ws.on('pong', () => {
        console.log('[📶] Ping OK.');
    });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (!Array.isArray(data) || typeof data[1] !== 'object') {
                return;
            }

            const { cmd, sid, d1, d2, d3, gBB } = data[1];

            if (![1011, 10000, 10001, 1008, 100].includes(cmd)) {
                console.log('[MSG] cmd:', cmd, '| data:', JSON.stringify(data[1]));
            }

            if (cmd === 1005 && data[1].htr) {
                lichSu = data[1].htr.map(p => {
                    const tong = p.d1 + p.d2 + p.d3;
                    return {
                        Phien: p.sid,
                        Xuc_xac_1: p.d1,
                        Xuc_xac_2: p.d2,
                        Xuc_xac_3: p.d3,
                        Tong: tong,
                        Ket_qua: tong > 10 ? "Tài" : "Xỉu"
                    };
                }).reverse();
                // Cập nhật phiên mới nhất
                if (lichSu.length > 0) {
                    const last = lichSu[0];
                    apiResponseData = { ...last, id: "@tiendataox" };
                    console.log(`[Lịch sử] Đã load ${lichSu.length} phiên. Mới nhất: Phiên ${last.Phien} - ${last.Ket_qua}`);
                }
            }

            if (cmd === 1008 && sid) {
                currentSessionId = sid;
            }

            if (cmd === 1003 && d1 && d2 && d3) {
                // Reset stale timer khi nhận được data
                lastDataTime = Date.now();
                clearTimeout(staleTimer);
                staleTimer = setTimeout(() => {
                    console.log('[⚠️] Không có dữ liệu 90s — reconnect...');
                    if (ws) ws.close();
                }, STALE_TIMEOUT);

                const total = d1 + d2 + d3;
                const result = (total > 10) ? "Tài" : "Xỉu";

                apiResponseData = {
                    "Phien": currentSessionId,
                    "Xuc_xac_1": d1,
                    "Xuc_xac_2": d2,
                    "Xuc_xac_3": d3,
                    "Tong": total,
                    "Ket_qua": result,
                    "id": "@tiendataox"
                };

                // Thêm vào đầu lịch sử - giữ 500 phiên
                lichSu.unshift({ Phien: currentSessionId, Xuc_xac_1: d1, Xuc_xac_2: d2, Xuc_xac_3: d3, Tong: total, Ket_qua: result });
                if (lichSu.length > 500) lichSu.pop();

                // Gửi dữ liệu lên server lc79
                fetch('https://lc79-server-production.up.railway.app/api/update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        Phien: currentSessionId,
                        Xuc_xac_1: d1, Xuc_xac_2: d2, Xuc_xac_3: d3,
                        Tong: total, Ket_qua: result
                    })
                }).catch(e => console.error('[❌] Gửi lc79 thất bại:', e.message));
                
                console.log(`Phiên ${apiResponseData.Phien}: ${apiResponseData.Tong} (${apiResponseData.Ket_qua})`);
                
                currentSessionId = null;
            }
        } catch (e) {
            console.error('[❌] Lỗi xử lý message:', e.message);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[🔌] WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
        clearInterval(pingInterval);
        clearTimeout(staleTimer);
        clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(connectWebSocket, RECONNECT_DELAY);
    });

    ws.on('error', (err) => {
        console.error('[❌] WebSocket error:', err.message);
        ws.close();
    });
}

// Thuật toán Thành - bảng nhả cố định
const NHA_GOC = {1:5, 2:4, 3:6, 4:2, 5:1, 6:3};

function duDoanThanh(d1, d2, d3) {
    const count = {};
    function nha(v) { count[v] = (count[v]||0)+1; let r = NHA_GOC[v]-(count[v]-1); return r<1?1:r; }
    const r3=nha(d3), r2=nha(d2), r1=nha(d1);
    const tong = r1+r2+r3;
    return { d1:r1, d2:r2, d3:r3, tong, kq: tong>10?'Tài':'Xỉu' };
}

// Pattern TXT: tìm chuỗi dài nhất có độ tin cậy cao nhất
function duDoanPattern(lichSuData) {
    if (lichSuData.length < 5) return null;

    const chuoi = lichSuData.map(p => p.Ket_qua === 'Tài' ? 'T' : 'X');
    let bestResult = null;

    // Thử pattern từ dài nhất (12) xuống ngắn nhất (3)
    for (let len = 12; len >= 3; len--) {
        if (chuoi.length < len + 2) continue;
        const patternHienTai = chuoi.slice(0, len).join('');
        let matchT = 0, matchX = 0;

        // Tìm pattern này trong lịch sử và xem phiên tiếp theo là gì
        for (let i = len; i < chuoi.length - 1; i++) {
            const p = chuoi.slice(i - len, i).join('');
            if (p === patternHienTai) {
                chuoi[i] === 'T' ? matchT++ : matchX++;
            }
        }

        const total = matchT + matchX;
        // Pattern dài cần ít mẫu hơn vì khó lặp lại, pattern ngắn cần nhiều mẫu hơn
        const minMau = len >= 8 ? 2 : len >= 5 ? 3 : 4;
        if (total < minMau) continue;

        const doTin = Math.round(Math.max(matchT, matchX) / total * 100);
        if (!bestResult || doTin > bestResult.doTin) {
            bestResult = {
                pattern: patternHienTai,
                len, matchT, matchX, total,
                duDoan: matchT >= matchX ? 'Tài' : 'Xỉu',
                doTin
            };
        }
    }
    return bestResult;
}

app.get('/api/dudoan', (req, res) => {
    if (lichSu.length < 2) return res.json({ error: 'Chưa đủ dữ liệu' });

    const current = lichSu[0];
    const ddThanh = duDoanThanh(current.Xuc_xac_1, current.Xuc_xac_2, current.Xuc_xac_3);
    const pattern = duDoanPattern(lichSu);

    // Kết hợp: nếu pattern có độ tin cậy >= 65% thì ưu tiên pattern
    let duDoanCuoi = ddThanh.kq;
    let dieuChinh = false;
    if (pattern && pattern.doTin >= 65) {
        duDoanCuoi = pattern.duDoan;
        dieuChinh = pattern.duDoan !== ddThanh.kq;
    }

    const historyTemp = [];
    for (let i = Math.min(499, lichSu.length - 2); i >= 0; i--) {
        const thuc = lichSu[i];
        const truoc = lichSu[i+1];
        const predThanh = duDoanThanh(truoc.Xuc_xac_1, truoc.Xuc_xac_2, truoc.Xuc_xac_3);
        const predPattern = duDoanPattern(lichSu.slice(i+1));
        let predFinal = predThanh.kq;
        if (predPattern && predPattern.doTin >= 65) predFinal = predPattern.duDoan;
        historyTemp.push({
            Phien: thuc.Phien,
            Du_doan: predFinal,
            Ket_qua: thuc.Ket_qua,
            Dung_sai: predFinal === thuc.Ket_qua ? 'Đúng' : 'Sai',
            Tong_du_doan: predThanh.tong
        });
    }
    const history = historyTemp.reverse();

    let saiLienTiep = 0;
    for (let i = 0; i < history.length; i++) {
        if (history[i].Dung_sai === 'Sai') saiLienTiep++;
        else break;
    }

    const dungCount = history.filter(h => h.Dung_sai === 'Đúng').length;

    res.json({
        Phien_tiep_theo: current.Phien + 1,
        Du_doan: duDoanCuoi,
        Du_doan_goc: ddThanh.kq,
        Xuc_xac_du_doan: { d1: ddThanh.d1, d2: ddThanh.d2, d3: ddThanh.d3 },
        Tong_du_doan: ddThanh.tong,
        Sai_lien_tiep: saiLienTiep,
        Dieu_chinh: dieuChinh,
        Pattern: pattern,
        Ty_le_dung: `${dungCount}/${history.length} (${Math.round(dungCount/history.length*100)}%)`,
        Lich_su: history.slice(0, 100), // Trả về 100 phiên gần nhất cho client
        id: '@tiendataox'
    });
});

app.get('/api/ditmemaysun', (req, res) => {
    res.json(apiResponseData);
});

app.get('/api/lichsu', (req, res) => {
    res.json(lichSu);
});

app.get('/', (req, res) => {
    res.json(apiResponseData);
});

app.listen(PORT, () => {
    console.log(`[🌐] Server is running at http://localhost:${PORT}`);
    connectWebSocket();
});