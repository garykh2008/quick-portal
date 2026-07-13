const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// 確保 uploads 目錄存在
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

// 記憶體中暫存的狀態
let textHistory = []; // 存放共享文字歷史 [{ id, text, timestamp }]
let fileDatabase = {}; // 存放檔案資訊 { filename: { originalName, size, uploadTime, isTemp } }

// 設定 Multer 檔案儲存
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    // 使用 timestamp 避免檔名衝突，但保留原始檔名以便下載
    const uniqueFilename = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueFilename);
  }
});

const upload = multer({ storage });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 取得本機 IP 地址，方便其他裝置連線
function getLocalIPs() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const results = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // 取得 IPv4 且非內部迴圈 (Loopback) 的 IP
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }
  return results;
}

// 廣播 WebSocket 訊息給所有客戶端
function broadcast(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// 取得當前檔案列表
function getFileList() {
  return Object.keys(fileDatabase).map(filename => ({
    filename,
    originalName: fileDatabase[filename].originalName,
    size: fileDatabase[filename].size,
    uploadTime: fileDatabase[filename].uploadTime,
  }));
}

// REST API: 上傳檔案
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const filename = req.file.filename;
  fileDatabase[filename] = {
    originalName: req.file.originalname,
    size: req.file.size,
    uploadTime: Date.now(),
    isTemp: true // 預設為暫存檔案，下載即刪除
  };

  // 廣播新檔案列表
  broadcast({
    type: 'file-list',
    files: getFileList()
  });

  res.json({
    success: true,
    filename,
    originalName: req.file.originalname
  });
});

// REST API: 下載特定檔案
app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(UPLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  const fileInfo = fileDatabase[filename];
  const originalName = fileInfo ? fileInfo.originalName : filename;

  // 設定下載檔名
  res.download(filePath, originalName, (err) => {
    if (err) {
      console.error('Download error:', err);
      return;
    }

    // 下載完成後的自動刪除邏輯
    if (fileInfo && fileInfo.isTemp) {
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) console.error('Unlink error:', unlinkErr);
        delete fileDatabase[filename];
        
        // 廣播更新後的檔案列表
        broadcast({
          type: 'file-list',
          files: getFileList()
        });
      });
    }
  });
});

// REST API: 下載最新檔案 (情境一: 實驗機下載最新編譯檔案)
app.get('/api/download/latest', (req, res) => {
  const files = Object.keys(fileDatabase);
  if (files.length === 0) {
    return res.status(404).send('No files available');
  }

  // 依上傳時間排序，找出最新的檔案
  const latestFilename = files.reduce((latest, current) => {
    return fileDatabase[current].uploadTime > fileDatabase[latest].uploadTime ? current : latest;
  }, files[0]);

  const filePath = path.join(UPLOADS_DIR, latestFilename);
  const fileInfo = fileDatabase[latestFilename];

  res.download(filePath, fileInfo.originalName, (err) => {
    if (err) {
      console.error('Download latest error:', err);
      return;
    }

    if (fileInfo && fileInfo.isTemp) {
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) console.error('Unlink error:', unlinkErr);
        delete fileDatabase[latestFilename];
        
        broadcast({
          type: 'file-list',
          files: getFileList()
        });
      });
    }
  });
});

// REST API: 共享文字/網址 (供 curl / CLI 使用)
app.post('/api/text', (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Text content is required' });
  }

  const textItem = {
    id: Date.now().toString(),
    text,
    timestamp: Date.now()
  };

  textHistory.unshift(textItem);
  if (textHistory.length > 50) textHistory.pop(); // 保留最近 50 筆

  broadcast({
    type: 'text-share',
    history: textHistory
  });

  res.json({ success: true, item: textItem });
});

// REST API: 取得伺服器狀態
app.get('/api/status', (req, res) => {
  res.json({
    activePeers: wss.clients.size,
    files: getFileList(),
    textHistory
  });
});

const url = require('url');

// 儲存實體裝置連線對照：Map<deviceId, { deviceId, nickname, wsClients: Set, lastActiveWs }>
const devices = new Map();

// 取得當前所有在線實體裝置列表
function getDeviceList() {
  return Array.from(devices.values()).map(d => ({
    deviceId: d.deviceId,
    nickname: d.nickname
  }));
}

wss.on('connection', (ws, req) => {
  const parsedUrl = url.parse(req.url, true);
  let deviceId = parsedUrl.query.deviceId;
  let nickname = parsedUrl.query.nickname;

  // 若無 deviceId (如 CLI)，給予隨機 id 且不進行多連線歸戶
  if (!deviceId) {
    deviceId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
  }
  if (!nickname) {
    nickname = `Device-${deviceId.substring(deviceId.length - 4)}`;
  }

  // 取得或建立裝置 Group
  let device = devices.get(deviceId);
  if (!device) {
    device = {
      deviceId,
      nickname,
      wsClients: new Set(),
      lastActiveWs: ws
    };
    devices.set(deviceId, device);
  }
  device.wsClients.add(ws);
  device.lastActiveWs = ws; // 以最新的連線為代表

  // 將 deviceId 綁定到 ws 上以供後續存取
  ws.deviceId = deviceId;

  // 回傳初始資訊給連線的 client
  ws.send(JSON.stringify({
    type: 'init',
    clientId: deviceId, // 前端以 deviceId 為 identity
    nickname: device.nickname,
    activePeers: devices.size,
    files: getFileList(),
    textHistory
  }));

  // 廣播最新在線人數與 Peer 異動
  broadcast({
    type: 'peer-update',
    activePeers: devices.size,
    peers: getDeviceList()
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const currentDevice = devices.get(ws.deviceId);

      switch (data.type) {
        case 'client-rename':
          if (currentDevice) {
            currentDevice.nickname = data.nickname;
            broadcast({
              type: 'peer-update',
              activePeers: devices.size,
              peers: getDeviceList()
            });
          }
          break;

        case 'text-share':
          const senderName = currentDevice ? currentDevice.nickname : 'Unknown';
          const textItem = {
            id: Date.now().toString(),
            text: data.text,
            timestamp: Date.now(),
            sender: senderName
          };

          if (data.targetClientId) {
            // 定向傳送模式 (Private Message)
            const targetDevice = devices.get(data.targetClientId);
            if (targetDevice) {
              textItem.isPrivate = true;
              textItem.targetClientId = data.targetClientId;
              textItem.targetNickname = targetDevice.nickname;
              
              const payload = JSON.stringify({
                type: 'private-text',
                item: textItem
              });

              // 轉發給接收端裝置下的所有 WS 視窗
              targetDevice.wsClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) client.send(payload);
              });

              // 轉發給發送端裝置下的所有 WS 視窗 (若不是同裝置)
              if (data.targetClientId !== ws.deviceId && currentDevice) {
                currentDevice.wsClients.forEach(client => {
                  if (client.readyState === WebSocket.OPEN) client.send(payload);
                });
              }
            }
          } else {
            // 廣播模式 (Broadcast)
            textHistory.unshift(textItem);
            if (textHistory.length > 50) textHistory.pop();

            broadcast({
              type: 'text-share',
              history: textHistory
            });
          }
          break;

        case 'signal':
          // 轉發 WebRTC 訊令給目標裝置的 lastActiveWs
          const targetDeviceObj = devices.get(data.targetClientId);
          if (targetDeviceObj && targetDeviceObj.lastActiveWs && targetDeviceObj.lastActiveWs.readyState === WebSocket.OPEN) {
            targetDeviceObj.lastActiveWs.send(JSON.stringify({
              type: 'signal',
              senderClientId: ws.deviceId, // 使用實體裝置的 deviceId
              signalData: data.signalData
            }));
          }
          break;
          
        case 'delete-file':
          // 允許手動刪除暫存檔案
          const filename = data.filename;
          const filePath = path.join(UPLOADS_DIR, filename);
          if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
              if (err) console.error('Delete error:', err);
              delete fileDatabase[filename];
              broadcast({
                type: 'file-list',
                files: getFileList()
              });
            });
          }
          break;
      }
    } catch (err) {
      console.error('WebSocket message parsing error:', err);
    }
  });

  ws.on('close', () => {
    const d = devices.get(ws.deviceId);
    if (d) {
      d.wsClients.delete(ws);
      if (d.wsClients.size === 0) {
        devices.delete(ws.deviceId);
      } else if (d.lastActiveWs === ws) {
        d.lastActiveWs = Array.from(d.wsClients)[0]; // 轉移代表連線
      }
    }
    broadcast({
      type: 'peer-update',
      activePeers: devices.size,
      peers: getDeviceList()
    });
  });
});

// 定時排程：每分鐘清除一次超過 15 分鐘的檔案
setInterval(() => {
  const now = Date.now();
  const expirationTime = 15 * 60 * 1000; // 15 分鐘

  Object.keys(fileDatabase).forEach(filename => {
    const fileInfo = fileDatabase[filename];
    if (fileInfo.isTemp && (now - fileInfo.uploadTime > expirationTime)) {
      const filePath = path.join(UPLOADS_DIR, filename);
      if (fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
          if (err) console.error('Scheduled cleanup error:', err);
          delete fileDatabase[filename];
          
          broadcast({
            type: 'file-list',
            files: getFileList()
          });
          console.log(`Cleaned up expired file: ${fileInfo.originalName}`);
        });
      } else {
        delete fileDatabase[filename];
      }
    }
  });
}, 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`========================================`);
  console.log(`🚀 Quick Portal Server is running!`);
  console.log(`========================================`);
  console.log(`Local Access: http://localhost:${PORT}`);
  console.log(`Network Access:`);
  getLocalIPs().forEach(ip => {
    console.log(`   http://${ip}:${PORT}`);
  });
  console.log(`========================================`);
});
