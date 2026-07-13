const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const url = require('url');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// 確保 uploads 目錄存在
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

// 多用戶記憶體資料庫：username -> { password, textHistory: [], fileDatabase: {}, devices: Map(ip -> { name, lastActive }) }
const users = new Map();

// 輔助工具：將資料存入 users.json 實現本地持久化
function saveUsersToDisk() {
  const data = {};
  users.forEach((info, username) => {
    data[username] = {
      password: info.password,
      textHistory: info.textHistory,
      fileDatabase: info.fileDatabase,
      devices: Array.from(info.devices.entries())
    };
  });
  try {
    fs.writeFileSync(path.join(__dirname, 'users.json'), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save users to disk:', err);
  }
}

// 輔助工具：自 users.json 載入使用者資料
function loadUsersFromDisk() {
  const filePath = path.join(__dirname, 'users.json');
  if (fs.existsSync(filePath)) {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(fileContent);
      Object.keys(data).forEach(username => {
        users.set(username, {
          password: data[username].password,
          textHistory: data[username].textHistory || [],
          fileDatabase: data[username].fileDatabase || {},
          devices: new Map(data[username].devices || [])
        });
      });
      console.log('🚀 Successfully loaded users from disk.');
    } catch (e) {
      console.error('Failed to load users from disk:', e);
    }
  }
}

// 載入持久化檔案
loadUsersFromDisk();

// 輔助工具：解析 Cookie 字串
function parseCookies(cookieStr) {
  const cookies = {};
  if (!cookieStr) return cookies;
  cookieStr.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    cookies[parts.shift().trim()] = decodeURIComponent(parts.join('='));
  });
  return cookies;
}

// 輔助工具：獲取當前請求關聯 we username
function getUsernameFromReq(req) {
  if (req.headers.cookie) {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.username) return cookies.username;
  }
  const parsedUrl = url.parse(req.url, true);
  if (parsedUrl.query && parsedUrl.query.username) {
    return parsedUrl.query.username;
  }
  return null;
}

// 輔助工具：獲取使用者，此時確保 username 已經由註冊/登入建立過
function getOrCreateUser(username) {
  return users.get(username);
}

// 輔助工具：正規化客戶端 IP
function getCleanIp(remoteAddress) {
  let ip = remoteAddress || '';
  if (ip.includes('::ffff:')) {
    ip = ip.split('::ffff:')[1];
  } else if (ip === '::1') {
    ip = '127.0.0.1';
  }
  return ip;
}

// 輔助工具：檢查某個已登記的 IP 當前是否在線
function isDeviceOnline(username, ip) {
  let online = false;
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === username && client.ip === ip) {
      online = true;
    }
  });
  return online;
}

// 輔助工具：獲取特定使用者的實體裝置清單 (IP 歸戶展示層)
function getUserDeviceList(username) {
  const user = getOrCreateUser(username);
  if (!user) return [];
  const list = [];
  user.devices.forEach((info, ip) => {
    list.push({
      ip,
      name: info.name,
      isOnline: isDeviceOnline(username, ip)
    });
  });
  return list;
}

// 獲取在線的實體裝置 (IP) 數量 (排除離線)
function getActiveDeviceCount(username) {
  const activeIps = new Set();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === username) {
      activeIps.add(client.ip);
    }
  });
  return activeIps.size;
}

// 獲取特定使用者底下的底層連線清單 (排除自身連線，用於 WebRTC 點對點連線與信令)
function getUserPeerList(username, excludeDeviceId) {
  const list = [];
  const user = users.get(username);
  if (!user) return [];
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === username && client.deviceId !== excludeDeviceId) {
      const deviceName = user.devices.has(client.ip) ? user.devices.get(client.ip).name : 'Device';
      list.push({
        deviceId: client.deviceId,
        ip: client.ip,
        nickname: deviceName
      });
    }
  });
  return list;
}

// 廣播最新在線人數、底層 Peer 異動與表層裝置清單給同帳號所有在線連接
function broadcastPeerUpdate(username) {
  if (!username) return;
  const activeCount = getActiveDeviceCount(username);
  const devList = getUserDeviceList(username);

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === username) {
      client.send(JSON.stringify({
        type: 'peer-update',
        activePeers: activeCount,
        peers: getUserPeerList(username, client.deviceId),
        deviceList: devList
      }));
    }
  });
}

// 輔助工具：獲取特定使用者的檔案列表
function getFileListForUser(username) {
  const user = getOrCreateUser(username);
  if (!user) return [];
  return Object.keys(user.fileDatabase).map(filename => ({
    filename,
    originalName: user.fileDatabase[filename].originalName,
    size: user.fileDatabase[filename].size,
    uploadTime: user.fileDatabase[filename].uploadTime,
  }));
}

// 設定 Multer 檔案儲存
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
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
      if (net.family === 'IPv4' && !net.internal) {
        results.push(net.address);
      }
    }
  }
  return results;
}

// ==========================================
// 🚀 使用者認證與裝置管理 REST API
// ==========================================

// 註冊 API
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號與密碼' });
  }

  const trimmedUser = username.trim();
  if (users.has(trimmedUser)) {
    return res.status(400).json({ error: '此帳號已存在' });
  }

  // 寫入記憶體資料庫
  users.set(trimmedUser, {
    password: password,
    textHistory: [],
    fileDatabase: {},
    devices: new Map()
  });

  // 持久化儲存
  saveUsersToDisk();

  // 設定 Cookie (Max-Age 30 天)
  res.setHeader('Set-Cookie', `username=${encodeURIComponent(trimmedUser)}; Path=/; HttpOnly; Max-Age=2592000`);
  res.json({ success: true, username: trimmedUser });
});

// 登入 API
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號與密碼' });
  }

  const trimmedUser = username.trim();
  const user = users.get(trimmedUser);
  if (!user || user.password !== password) {
    return res.status(400).json({ error: '帳號或密碼錯誤' });
  }

  res.setHeader('Set-Cookie', `username=${encodeURIComponent(trimmedUser)}; Path=/; HttpOnly; Max-Age=2592000`);
  res.json({ success: true, username: trimmedUser });
});

// 登出 API
app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `username=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ success: true });
});

// 當前登入者與裝置列表 API (加上存在性認證，防自動建立空密碼帳戶)
app.get('/api/auth/me', (req, res) => {
  const username = getUsernameFromReq(req);
  if (!username || !users.has(username)) {
    return res.json({ loggedIn: false });
  }
  res.json({
    loggedIn: true,
    username,
    devices: getUserDeviceList(username)
  });
});

// 裝置暱稱命名 API
app.post('/api/auth/device/rename', (req, res) => {
  const username = getUsernameFromReq(req);
  if (!username || !users.has(username)) return res.status(401).json({ error: '請先登入' });

  const { ip, name } = req.body;
  if (!ip || !name) return res.status(400).json({ error: '缺乏裝置 IP 或名稱' });

  const user = getOrCreateUser(username);
  const device = user.devices.get(ip);
  if (device) {
    device.name = name;
    device.lastActive = Date.now();

    // 持久化儲存
    saveUsersToDisk();

    // 廣播給該使用者旗下所有在線裝置更新 Peer 列表
    broadcastPeerUpdate(username);
    return res.json({ success: true });
  }
  res.status(404).json({ error: '找不到該裝置' });
});

// 刪除裝置 API (解綁)
app.post('/api/auth/device/delete', (req, res) => {
  const username = getUsernameFromReq(req);
  if (!username || !users.has(username)) return res.status(401).json({ error: '請先登入' });

  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: '缺乏裝置 IP' });

  const user = getOrCreateUser(username);
  if (user.devices.has(ip)) {
    user.devices.delete(ip);

    // 持久化儲存
    saveUsersToDisk();

    // 廣播給該使用者旗下所有在線裝置更新 Peer 列表
    broadcastPeerUpdate(username);
    return res.json({ success: true });
  }
  res.status(404).json({ error: '找不到該裝置' });
});

// ==========================================
// 📂 檔案與文字共享 REST API (隔離多帳號)
// ==========================================

// 上傳檔案
app.post('/api/upload', upload.single('file'), (req, res) => {
  const username = getUsernameFromReq(req);
  if (!username || !users.has(username)) {
    return res.status(401).json({ error: '請先登入' });
  }

  if (!req.file) {
    return res.status(400).json({ error: '未選擇任何檔案' });
  }

  const user = getOrCreateUser(username);
  const filename = req.file.filename;
  user.fileDatabase[filename] = {
    originalName: req.file.originalname,
    size: req.file.size,
    uploadTime: Date.now(),
    isTemp: true
  };

  // 廣播新檔案列表
  const payload = {
    type: 'file-list',
    files: getFileListForUser(username)
  };
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === username) {
      client.send(JSON.stringify(payload));
    }
  });

  res.json({
    success: true,
    filename,
    originalName: req.file.originalname
  });
});

// 下載檔案 (下載即刪)
app.get('/api/download/:filename', (req, res) => {
  const username = getUsernameFromReq(req);
  if (!username || !users.has(username)) {
    return res.status(401).send('請先登入');
  }

  const filename = req.params.filename;
  const filePath = path.join(UPLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('找不到該檔案');
  }

  const user = getOrCreateUser(username);
  const fileInfo = user.fileDatabase[filename];
  const originalName = fileInfo ? fileInfo.originalName : filename;

  res.download(filePath, originalName, (err) => {
    if (err) {
      console.error('Download error:', err);
      return;
    }

    if (fileInfo && fileInfo.isTemp) {
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) console.error('Unlink error:', unlinkErr);
        delete user.fileDatabase[filename];
        
        const payload = {
          type: 'file-list',
          files: getFileListForUser(username)
        };
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.username === username) {
            client.send(JSON.stringify(payload));
          }
        });
      });
    }
  });
});

// 下載最新檔案
app.get('/api/download/latest', (req, res) => {
  const username = getUsernameFromReq(req);
  if (!username || !users.has(username)) {
    return res.status(401).send('請先登入');
  }

  const user = getOrCreateUser(username);
  const files = Object.keys(user.fileDatabase);
  if (files.length === 0) {
    return res.status(404).send('目前沒有可下載的檔案');
  }

  const latestFilename = files.reduce((latest, current) => {
    return user.fileDatabase[current].uploadTime > user.fileDatabase[latest].uploadTime ? current : latest;
  }, files[0]);

  const filePath = path.join(UPLOADS_DIR, latestFilename);
  const fileInfo = user.fileDatabase[latestFilename];

  res.download(filePath, fileInfo.originalName, (err) => {
    if (err) {
      console.error('Download latest error:', err);
      return;
    }

    if (fileInfo && fileInfo.isTemp) {
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr) console.error('Unlink error:', unlinkErr);
        delete user.fileDatabase[latestFilename];
        
        const payload = {
          type: 'file-list',
          files: getFileListForUser(username)
        };
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN && client.username === username) {
            client.send(JSON.stringify(payload));
          }
        });
      });
    }
  });
});

// REST API: 共享文字/網址 (供 curl / CLI 使用)
app.post('/api/text', (req, res) => {
  const username = getUsernameFromReq(req);
  if (!username || !users.has(username)) {
    return res.status(401).json({ error: '請先登入' });
  }

  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: '文字內容不能為空' });
  }

  const user = getOrCreateUser(username);
  const textItem = {
    id: Date.now().toString(),
    text,
    timestamp: Date.now()
  };

  user.textHistory.unshift(textItem);
  if (user.textHistory.length > 50) user.textHistory.pop();

  const payload = {
    type: 'text-share',
    history: user.textHistory
  };
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.username === username) {
      client.send(JSON.stringify(payload));
    }
  });

  res.json({ success: true, item: textItem });
});

// REST API: 取得伺服器狀態
app.get('/api/status', (req, res) => {
  const username = getUsernameFromReq(req);
  if (!username || !users.has(username)) {
    return res.status(401).json({ error: '請先登入' });
  }
  const user = getOrCreateUser(username);
  res.json({
    activePeers: getActiveDeviceCount(username),
    files: getFileListForUser(username),
    textHistory: user.textHistory
  });
});

// ==========================================
// 🔌 WebSocket Signaling Server (底層與表層分流)
// ==========================================

wss.on('connection', (ws, req) => {
  const parsedUrl = url.parse(req.url, true);
  const cookies = parseCookies(req.headers.cookie);
  const username = parsedUrl.query.username || cookies.username;

  // 若未登入或帳號尚未被正式註冊，通知客戶端需要認證並斷開連線
  if (!username || !users.has(username)) {
    ws.send(JSON.stringify({ type: 'require-auth' }));
    ws.close();
    return;
  }

  const deviceId = parsedUrl.query.deviceId || `dev-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const ip = getCleanIp(req.socket.remoteAddress);
  
  ws.username = username;
  ws.deviceId = deviceId; // 底層 WebRTC 唯一 socket ID 標識，解決 signaling 衝突
  ws.ip = ip;             // 表層實體裝置 IP

  const user = getOrCreateUser(username);

  // 如果此 IP 尚未加入註冊裝置中，予以自動登錄
  if (!user.devices.has(ip)) {
    const lastOctet = ip.split('.').pop() || 'Unknown';
    let userAgent = req.headers['user-agent'] || '';
    let os = 'Device';
    if (userAgent.includes('Windows')) os = 'Win';
    else if (userAgent.includes('Macintosh')) os = 'Mac';
    else if (userAgent.includes('Linux')) os = 'Linux';
    else if (userAgent.includes('Android')) os = 'Android';
    else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) os = 'iOS';
    
    user.devices.set(ip, {
      name: `${os}-${lastOctet}`,
      lastActive: Date.now()
    });

    // 持久化儲存
    saveUsersToDisk();
  } else {
    user.devices.get(ip).lastActive = Date.now();
  }

  const deviceName = user.devices.get(ip).name;
  const activeCount = getActiveDeviceCount(username);
  const devList = getUserDeviceList(username);

  // 回傳初始資訊給連線的 client (解決 init 與 peer-update 競態條件)
  ws.send(JSON.stringify({
    type: 'init',
    clientId: deviceId, // 回復以 deviceId 作為唯一連線 ID
    nickname: deviceName,
    activePeers: activeCount,
    files: getFileListForUser(username),
    textHistory: user.textHistory,
    peers: getUserPeerList(username, deviceId),
    deviceList: devList
  }));

  // 廣播最新在線狀態給同帳號所有裝置
  broadcastPeerUpdate(username);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const user = getOrCreateUser(ws.username);
      if (!user) return;
      const currentDevice = user.devices.get(ws.ip);

      switch (data.type) {
        case 'client-rename':
          if (currentDevice) {
            currentDevice.name = data.nickname;
            currentDevice.lastActive = Date.now();
            
            saveUsersToDisk();
            broadcastPeerUpdate(ws.username);
          }
          break;

        case 'text-share':
          const senderName = currentDevice ? currentDevice.name : 'Unknown';
          const textItem = {
            id: Date.now().toString(),
            text: data.text,
            timestamp: Date.now(),
            sender: senderName
          };

          if (data.targetClientId && data.targetClientId !== 'all') {
            // 定向傳送模式 (目標為唯一的 deviceId)
            const targetId = data.targetClientId;
            
            const payload = JSON.stringify({
              type: 'private-text',
              item: textItem
            });

            // 轉發給接收端特定的 socket 連線
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.username === ws.username && client.deviceId === targetId) {
                client.send(payload);
              }
            });

            // 轉發回發送端自己 (以供多視窗顯示)
            ws.send(payload);
          } else {
            // 廣播模式 (Broadcast)
            user.textHistory.unshift(textItem);
            if (user.textHistory.length > 50) user.textHistory.pop();

            saveUsersToDisk();

            const broadcastPayload = JSON.stringify({
              type: 'text-share',
              history: user.textHistory
            });
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.username === ws.username) {
                client.send(broadcastPayload);
              }
            });
          }
          break;

        case 'signal':
          // 轉發 WebRTC 信令給特定目標的 deviceId 連線 (100% 避免信令廣播衝突)
          const targetId = data.targetClientId;
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.username === ws.username && client.deviceId === targetId) {
              client.send(JSON.stringify({
                type: 'signal',
                senderClientId: ws.deviceId, // 使用發送端的唯一 ID
                signalData: data.signalData
              }));
            }
          });
          break;
          
        case 'delete-file':
          // 允許手動刪除暫存檔案
          const filename = data.filename;
          const filePath = path.join(UPLOADS_DIR, filename);
          if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
              if (err) console.error('Delete error:', err);
              delete user.fileDatabase[filename];
              
              saveUsersToDisk();

              const fileListPayload = JSON.stringify({
                type: 'file-list',
                files: getFileListForUser(ws.username)
              });
              wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && client.username === ws.username) {
                  client.send(fileListPayload);
                }
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
    broadcastPeerUpdate(ws.username);
  });
});

// 定時排程：每分鐘清除一次超過 15 分鐘的檔案
setInterval(() => {
  const now = Date.now();
  const expirationTime = 15 * 60 * 1000;
  let didCleanup = false;

  users.forEach((user, username) => {
    Object.keys(user.fileDatabase).forEach(filename => {
      const fileInfo = user.fileDatabase[filename];
      if (fileInfo.isTemp && (now - fileInfo.uploadTime > expirationTime)) {
        const filePath = path.join(UPLOADS_DIR, filename);
        if (fs.existsSync(filePath)) {
          fs.unlink(filePath, (err) => {
            if (err) console.error('Scheduled cleanup error:', err);
            delete user.fileDatabase[filename];
            didCleanup = true;
            
            const fileListPayload = JSON.stringify({
              type: 'file-list',
              files: getFileListForUser(username)
            });
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.username === username) {
                client.send(fileListPayload);
              }
            });
            console.log(`Cleaned up expired file for user ${username}: ${fileInfo.originalName}`);
          });
        } else {
          delete user.fileDatabase[filename];
          didCleanup = true;
        }
      }
    });
  });

  if (didCleanup) {
    saveUsersToDisk();
  }
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
