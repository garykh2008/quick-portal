// 全局變數
let socket;
let clientId = null;
let myNickname = '';
let activePeers = 0;
let peerList = []; // 格式：[{ deviceId, nickname }]
let connectionMode = 'server'; // 'server' 或 'p2p'

// 儲存所有與其他 Peer 的 WebRTC 連線 { peerId: { pc, dc } }
const rtcConnections = new Map();

// 檔案傳輸緩存 (接收端用)
const fileTransfers = {};

// 暫存資料 (用於混合排序小工具歷史選單)
let globalTextHistory = [];
let globalFileList = [];
let privateHistoryList = []; // 本地暫存的私密定向訊息歷史

// DOM 元素
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const peerCountBadge = document.getElementById('peer-count');
const modeBadge = document.getElementById('mode-badge');
const channelTypeBadge = document.getElementById('channel-type');
const btnOpenWidget = document.getElementById('btn-open-widget');
const connectionInfo = document.getElementById('connection-info');

// 裝置命名 DOM
const localNicknameInput = document.getElementById('local-nickname');

// 萬能輸入框與包裝器
const universalInputWrapper = document.getElementById('universal-input-wrapper');
const textInput = document.getElementById('text-input');
const btnSendText = document.getElementById('btn-send-text');
const textHistoryList = document.getElementById('text-history-list');
const charCountSpan = document.getElementById('char-count');
const textTargetSelect = document.getElementById('text-target-select');

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const sharedFileList = document.getElementById('shared-file-list');
const progressContainer = document.getElementById('progress-container');
const progressFilename = document.getElementById('progress-filename');
const progressPercent = document.getElementById('progress-percent');
const progressFill = document.getElementById('progress-fill');
const fileTargetSelect = document.getElementById('file-target-select');

// Widget 專用 DOM
const globalTargetBar = document.getElementById('global-target-bar');
const globalTargetSelect = document.getElementById('global-target-select');
const widgetActiveCard = document.getElementById('widget-active-card');
const widgetClipboardText = document.getElementById('widget-clipboard-text');
const widgetClipboardMeta = document.getElementById('widget-clipboard-meta');
const widgetBtnCopy = document.getElementById('widget-btn-copy');
const widgetBtnOpen = document.getElementById('widget-btn-open');
const widgetHistoryDropdown = document.getElementById('widget-history-dropdown');
const widgetHistoryList = document.getElementById('widget-history-list');

// Widget Tabs DOM
const tabBtnSend = document.getElementById('tab-btn-send');
const tabBtnReceive = document.getElementById('tab-btn-receive');
const unreadDot = document.getElementById('unread-dot');
let isInitDone = false; // 是否完成初始化載入

// Toast 通知
const toastContainer = document.getElementById('toast-container');

// WebRTC ICE 配置 (區域網路直連通常不需要複雜的 TURN 伺服器，STUN 即可)
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// 1. 初始化與模式判斷
const urlParams = new URLSearchParams(window.location.search);
const isWidgetMode = urlParams.get('mode') === 'widget' || window.innerWidth < 450;

if (isWidgetMode) {
  document.body.classList.add('widget-mode');
  document.body.classList.add('tab-send'); // 預設為傳送分頁
  if (modeBadge) modeBadge.textContent = '懸浮小工具';
  if (textInput) textInput.setAttribute('rows', '1');
}

// 監聽視窗調整
window.addEventListener('resize', () => {
  if (window.innerWidth < 450 && !document.body.classList.contains('widget-mode')) {
    document.body.classList.add('widget-mode');
    document.body.classList.add('tab-send');
    if (modeBadge) modeBadge.textContent = '懸浮小工具';
  }
});

// 開啟桌面懸浮小工具 (調整尺寸為 320x300 px)
if (btnOpenWidget) {
  btnOpenWidget.addEventListener('click', () => {
    const widgetUrl = `${window.location.origin}${window.location.pathname}?mode=widget`;
    window.open(
      widgetUrl,
      'QuickPortalWidget',
      'width=320,height=300,menubar=no,status=no,toolbar=no,location=no,personalbar=no'
    );
  });
}

// 小工具分頁切換事件監聽
if (isWidgetMode && tabBtnSend && tabBtnReceive) {
  tabBtnSend.addEventListener('click', () => {
    tabBtnSend.classList.add('active');
    tabBtnReceive.classList.remove('active');
    document.body.classList.remove('tab-receive');
    document.body.classList.add('tab-send');
  });

  tabBtnReceive.addEventListener('click', () => {
    tabBtnReceive.classList.add('active');
    tabBtnSend.classList.remove('active');
    document.body.classList.remove('tab-send');
    document.body.classList.add('tab-receive');
    if (unreadDot) {
      unreadDot.classList.add('hidden'); // 切換到接收頁即清除未讀紅點
    }
    updateWidgetOnDataChange(); // 切換時主動刷新與重算狀態
  });
}

// 未讀通知紅點觸發函式 (加強 log 便於排查)
function triggerUnreadDot() {
  console.log(`[Unread] triggerUnreadDot() - isWidgetMode: ${isWidgetMode}, isInitDone: ${isInitDone}, in tab-send: ${document.body.classList.contains('tab-send')}`);
  if (isWidgetMode && isInitDone && document.body.classList.contains('tab-send')) {
    if (unreadDot) {
      unreadDot.classList.remove('hidden');
      console.log("[Unread] 紅點已顯示");
    }
  }
}

// 2. Toast 提示通知函式
function showToast(message, type = 'info') {
  if (!toastContainer) return;
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let iconName = 'info';
  if (type === 'success') iconName = 'check-circle';
  if (type === 'error') iconName = 'alert-triangle';
  
  toast.innerHTML = `<i data-lucide="${iconName}" style="width:16px;height:16px;"></i> <span>${message}</span>`;
  toastContainer.appendChild(toast);
  lucide.createIcons();

  setTimeout(() => toast.classList.add('show'), 50);

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// 3. 裝置暱稱與 ID 初始化
function getOrCreateDeviceId() {
  let id = localStorage.getItem('quick-portal-device-id');
  if (!id) {
    id = `dev-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('quick-portal-device-id', id);
  }
  return id;
}

function initLocalNickname() {
  const savedName = localStorage.getItem('quick-portal-nickname');
  if (savedName) {
    myNickname = savedName;
  } else {
    myNickname = generateDefaultNickname();
    localStorage.setItem('quick-portal-nickname', myNickname);
  }
  
  if (localNicknameInput) {
    localNicknameInput.value = myNickname;
    
    localNicknameInput.addEventListener('change', () => {
      const newName = localNicknameInput.value.trim();
      if (newName && newName !== myNickname) {
        myNickname = newName;
        localStorage.setItem('quick-portal-nickname', myNickname);
        sendNicknameUpdate(myNickname);
      }
    });
    
    localNicknameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        localNicknameInput.blur();
      }
    });
  }
}

function generateDefaultNickname() {
  const ua = navigator.userAgent;
  let os = "Device";
  if (ua.indexOf("Windows") !== -1) os = "Win";
  else if (ua.indexOf("Macintosh") !== -1) os = "Mac";
  else if (ua.indexOf("Linux") !== -1) os = "Linux";
  else if (ua.indexOf("Android") !== -1) os = "Android";
  else if (ua.indexOf("iPhone") !== -1 || ua.indexOf("iPad") !== -1) os = "iOS";
  
  const randId = Math.floor(1000 + Math.random() * 9000);
  return `${os}-${randId}`;
}

function sendNicknameUpdate(nickname) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'client-rename',
      nickname
    }));
  }
}

function getPeerNickname(id) {
  if (id === clientId) return 'Me';
  const peer = peerList.find(p => p.deviceId === id);
  return peer ? peer.nickname : 'Unknown Device';
}

// 4. 建立 WebSocket 連線與 Signaling
function initWebSocket() {
  const deviceId = getOrCreateDeviceId();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/?deviceId=${deviceId}&nickname=${encodeURIComponent(myNickname)}`;
  
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    updateStatus('online', '已連線至伺服器');
    connectionInfo.textContent = `Server: ${window.location.host}`;
    sendNicknameUpdate(myNickname);
  };

  socket.onclose = () => {
    updateStatus('offline', '伺服器連線已斷開，嘗試重連...');
    setTimeout(initWebSocket, 3000);
    cleanupAllRTC();
  };

  socket.onerror = (err) => {
    console.error('WebSocket Error:', err);
  };

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    switch (data.type) {
      case 'init':
        clientId = data.clientId; 
        activePeers = data.activePeers;
        updatePeerCount(activePeers);
        updateTextHistory(data.textHistory);
        updateFileList(data.files);
        isInitDone = true; // 初始化完畢，開始監聽未讀
        break;

      case 'peer-update':
        activePeers = data.activePeers;
        peerList = data.peers.filter(p => p.deviceId !== clientId);
        updatePeerCount(activePeers);
        
        updateTargetSelectors();
        manageRTCConnections();
        break;

      case 'text-share':
        updateTextHistory(data.history);
        triggerUnreadDot();
        break;

      case 'private-text':
        addPrivateTextItem(data.item);
        triggerUnreadDot();
        break;

      case 'file-list':
        updateFileList(data.files);
        triggerUnreadDot();
        break;

      case 'signal':
        handleRTCSignal(data.senderClientId, data.signalData);
        break;
    }
  };
}

// 更新傳送對象下拉選單
function updateTargetSelectors() {
  const currentTextVal = textTargetSelect ? textTargetSelect.value : 'all';
  const currentFileVal = fileTargetSelect ? fileTargetSelect.value : 'server';
  const currentGlobalVal = globalTargetSelect ? globalTargetSelect.value : 'all';
  
  if (textTargetSelect) {
    textTargetSelect.innerHTML = '<option value="all">📢 廣播給所有人 (All)</option>';
    peerList.forEach(peer => {
      const opt = document.createElement('option');
      opt.value = peer.deviceId;
      opt.textContent = `📱 ${peer.nickname}`;
      textTargetSelect.appendChild(opt);
    });
    if (peerList.some(p => p.deviceId === currentTextVal)) {
      textTargetSelect.value = currentTextVal;
    } else {
      textTargetSelect.value = 'all';
    }
  }

  if (fileTargetSelect) {
    fileTargetSelect.innerHTML = '<option value="server">☁️ 上傳至 Server 暫存 (Everyone)</option>';
    peerList.forEach(peer => {
      const opt = document.createElement('option');
      opt.value = peer.deviceId;
      opt.textContent = `⚡ 直連傳送給 ${peer.nickname} (P2P)`;
      fileTargetSelect.appendChild(opt);
    });
    if (peerList.some(p => p.deviceId === currentFileVal)) {
      fileTargetSelect.value = currentFileVal;
    } else {
      fileTargetSelect.value = 'server';
    }
  }

  if (globalTargetSelect) {
    globalTargetSelect.innerHTML = '<option value="all">📢 廣播 (All/Server)</option>';
    peerList.forEach(peer => {
      const opt = document.createElement('option');
      opt.value = peer.deviceId;
      opt.textContent = `📱 ${peer.nickname}`;
      globalTargetSelect.appendChild(opt);
    });
    if (peerList.some(p => p.deviceId === currentGlobalVal)) {
      globalTargetSelect.value = currentGlobalVal;
    } else {
      globalTargetSelect.value = 'all';
    }
  }
}

// 更新狀態 UI
function updateStatus(state, text) {
  if (statusDot) {
    statusDot.className = 'status-indicator';
    statusDot.classList.add(state);
  }
  if (statusText) statusText.textContent = text;
  
  if (channelTypeBadge) {
    if (state === 'p2p') {
      channelTypeBadge.textContent = 'P2P 直連';
      channelTypeBadge.style.background = 'rgba(0, 242, 254, 0.15)';
      channelTypeBadge.style.color = '#00f2fe';
    } else {
      channelTypeBadge.textContent = 'Server 暫存';
      channelTypeBadge.style.background = 'rgba(177, 85, 255, 0.15)';
      channelTypeBadge.style.color = '#ff5e97';
    }
  }
}

function updatePeerCount(count) {
  if (peerCountBadge) {
    peerCountBadge.textContent = `${count} Peers`;
  }
}

// 5. WebRTC 連線管理 (P2P)
function manageRTCConnections() {
  const peerIds = peerList.map(p => p.deviceId);
  
  peerIds.forEach(peerId => {
    if (!rtcConnections.has(peerId)) {
      if (clientId < peerId) {
        initiateRTCConnection(peerId);
      }
    }
  });

  for (const peerId of rtcConnections.keys()) {
    if (!peerIds.includes(peerId)) {
      closeRTCConnection(peerId);
    }
  }

  checkConnectionMode();
}

function checkConnectionMode() {
  let hasConnectedP2P = false;
  for (const conn of rtcConnections.values()) {
    if (conn.pc && conn.pc.connectionState === 'connected') {
      hasConnectedP2P = true;
      break;
    }
  }
  
  if (hasConnectedP2P) {
    connectionMode = 'p2p';
    updateStatus('p2p', '區域網路 P2P 直連中');
  } else {
    connectionMode = 'server';
    updateStatus('online', '已連線 (Server 中繼)');
  }
}

function initiateRTCConnection(targetPeerId) {
  console.log(`[RTC] Initiating P2P connection to ${targetPeerId}`);
  const pc = new RTCPeerConnection(rtcConfig);
  
  const dc = pc.createDataChannel('quick-portal-data', { ordered: true });
  setupDataChannel(dc, targetPeerId);

  const connObj = { pc, dc };
  rtcConnections.set(targetPeerId, connObj);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal(targetPeerId, { candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[RTC] Connection state with ${targetPeerId}: ${pc.connectionState}`);
    checkConnectionMode();
  };

  pc.createOffer()
    .then(offer => pc.setLocalDescription(offer))
    .then(() => {
      sendSignal(targetPeerId, { sdp: pc.localDescription });
    })
    .catch(err => console.error('[RTC] Create Offer Error:', err));
}

function handleRTCSignal(senderPeerId, signalData) {
  let connObj = rtcConnections.get(senderPeerId);

  if (signalData.sdp) {
    const sdp = new RTCSessionDescription(signalData.sdp);
    
    if (sdp.type === 'offer') {
      console.log(`[RTC] Received Offer from ${senderPeerId}`);
      const pc = new RTCPeerConnection(rtcConfig);
      
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal(senderPeerId, { candidate: event.candidate });
        }
      };

      pc.onconnectionstatechange = () => {
        console.log(`[RTC] Connection state with ${senderPeerId}: ${pc.connectionState}`);
        checkConnectionMode();
      };

      pc.ondatachannel = (event) => {
        const dc = event.channel;
        setupDataChannel(dc, senderPeerId);
        
        const currentConn = rtcConnections.get(senderPeerId) || {};
        currentConn.dc = dc;
        rtcConnections.set(senderPeerId, currentConn);
      };

      connObj = { pc, dc: null };
      rtcConnections.set(senderPeerId, connObj);

      pc.setRemoteDescription(sdp)
        .then(() => pc.createAnswer())
        .then(answer => pc.setLocalDescription(answer))
        .then(() => {
          sendSignal(senderPeerId, { sdp: pc.localDescription });
        })
        .catch(err => console.error('[RTC] Handle Offer Error:', err));

    } else if (sdp.type === 'answer') {
      console.log(`[RTC] Received Answer from ${senderPeerId}`);
      if (connObj && connObj.pc) {
        connObj.pc.setRemoteDescription(sdp)
          .catch(err => console.error('[RTC] Handle Answer Error:', err));
      }
    }
  } else if (signalData.candidate) {
    if (connObj && connObj.pc) {
      connObj.pc.addIceCandidate(new RTCIceCandidate(signalData.candidate))
        .catch(err => console.error('[RTC] Add Ice Candidate Error:', err));
    }
  }
}

function sendSignal(targetClientId, signalData) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'signal',
      targetClientId,
      signalData
    }));
  }
}

function setupDataChannel(dc, peerId) {
  dc.binaryType = 'arraybuffer';

  dc.onopen = () => {
    console.log(`[RTC] Data channel with ${peerId} is open`);
    checkConnectionMode();
  };

  dc.onclose = () => {
    console.log(`[RTC] Data channel with ${peerId} is closed`);
    checkConnectionMode();
  };

  dc.onmessage = (event) => {
    handleDataChannelMessage(event.data, peerId);
  };
}

// 6. Data Channel 訊息協定處理 (P2P)
function handleDataChannelMessage(data, peerId) {
  if (typeof data === 'string') {
    const msg = JSON.parse(data);
    
    switch (msg.type) {
      case 'p2p-text':
        const senderNickname = getPeerNickname(peerId);
        const item = {
          id: Date.now().toString(),
          text: msg.text,
          timestamp: Date.now(),
          sender: senderNickname,
          isPrivate: true,
          targetNickname: 'Me'
        };
        addPrivateTextItem(item);
        triggerUnreadDot();
        break;

      case 'file-start':
        const transferId = msg.transferId;
        fileTransfers[transferId] = {
          filename: msg.filename,
          size: msg.size,
          receivedSize: 0,
          chunks: [],
          peerId: peerId
        };
        showProgressUI(msg.filename);
        updateProgressUI(0);
        showToast(`開始接收來自 ${getPeerNickname(peerId)} 的檔案...`, 'info');
        break;

      case 'file-end':
        const tId = msg.transferId;
        const transfer = fileTransfers[tId];
        if (transfer) {
          const blob = new Blob(transfer.chunks);
          const url = URL.createObjectURL(blob);
          
          const a = document.createElement('a');
          a.href = url;
          a.download = transfer.filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          
          hideProgressUI();
          showToast(`已完成 P2P 檔案接收並下載：${transfer.filename}`, 'success');
          
          // 如果在小工具模式，也把檔案當作最新卡片顯示
          if (isWidgetMode) {
            updateWidgetActiveCardWithLocalFile(transfer.filename, transfer.size, url);
            triggerUnreadDot();
          }
          delete fileTransfers[tId];
        }
        break;
    }
  } else {
    const transfer = fileTransfers[Object.keys(fileTransfers)[0]];
    if (transfer) {
      transfer.chunks.push(data);
      transfer.receivedSize += data.byteLength;
      
      const percent = Math.min(100, Math.round((transfer.receivedSize / transfer.size) * 100));
      updateProgressUI(percent);
    }
  }
}

// P2P 檔案分片傳送
async function sendFileP2P(file, dc) {
  const transferId = `tf-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
  const CHUNK_SIZE = 16384; 
  
  dc.send(JSON.stringify({
    type: 'file-start',
    transferId,
    filename: file.name,
    size: file.size
  }));

  showProgressUI(file.name);
  showToast('正在透過 P2P 直連傳送檔案...', 'info');

  let offset = 0;
  const fileReader = new FileReader();

  const readSlice = () => {
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    fileReader.readAsArrayBuffer(slice);
  };

  fileReader.onload = async (e) => {
    const buffer = e.target.result;
    
    if (dc.bufferedAmount > 1048576) { 
      await new Promise(resolve => {
        dc.onbufferedamountlow = () => {
          dc.onbufferedamountlow = null;
          resolve();
        };
      });
    }

    dc.send(buffer);
    offset += buffer.byteLength;
    
    const percent = Math.min(100, Math.round((offset / file.size) * 100));
    updateProgressUI(percent);

    if (offset < file.size) {
      readSlice();
    } else {
      dc.send(JSON.stringify({
        type: 'file-end',
        transferId
      }));
      setTimeout(hideProgressUI, 1000);
      showToast('檔案傳送成功 (P2P)！', 'success');
    }
  };

  readSlice();
}

function closeRTCConnection(peerId) {
  const conn = rtcConnections.get(peerId);
  if (conn) {
    if (conn.dc) conn.dc.close();
    if (conn.pc) conn.pc.close();
    rtcConnections.delete(peerId);
  }
}

function cleanupAllRTC() {
  for (const peerId of rtcConnections.keys()) {
    closeRTCConnection(peerId);
  }
  checkConnectionMode();
}

// 7. UI 更新與操作邏輯

btnSendText.addEventListener('click', sendSharedText);
textInput.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') {
    sendSharedText();
  }
  if (isWidgetMode && e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
    e.preventDefault();
    sendSharedText();
  }
});

textInput.addEventListener('input', () => {
  if (charCountSpan) {
    charCountSpan.textContent = `${textInput.value.length} 字`;
  }
});

// 萬能輸入框 Drag & Drop
if (universalInputWrapper) {
  universalInputWrapper.addEventListener('dragover', (e) => {
    e.preventDefault();
    universalInputWrapper.classList.add('dragover');
  });

  universalInputWrapper.addEventListener('dragleave', () => {
    universalInputWrapper.classList.remove('dragover');
  });

  universalInputWrapper.addEventListener('drop', (e) => {
    e.preventDefault();
    universalInputWrapper.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFilesSelection(files);
    }
  });
}

// 萬能輸入框 Paste (Ctrl+V)
if (textInput) {
  textInput.addEventListener('paste', (e) => {
    const files = e.clipboardData.files;
    if (files.length > 0) {
      e.preventDefault();
      handleFilesSelection(files);
    }
  });
}

function sendSharedText() {
  const text = textInput.value.trim();
  if (!text) return;

  const targetVal = isWidgetMode ? globalTargetSelect.value : textTargetSelect.value;

  if (targetVal === 'all') {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'text-share',
        text
      }));
    }
  } else {
    const targetConn = rtcConnections.get(targetVal);
    
    if (targetConn && targetConn.dc && targetConn.dc.readyState === 'open') {
      targetConn.dc.send(JSON.stringify({
        type: 'p2p-text',
        text
      }));
      
      const targetName = getPeerNickname(targetVal);
      const privateItem = {
        id: Date.now().toString(),
        text,
        timestamp: Date.now(),
        sender: 'Me',
        isPrivate: true,
        targetNickname: targetName
      };
      addPrivateTextItem(privateItem);
      
    } else {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'text-share',
          text,
          targetClientId: targetVal
        }));
      }
    }
  }
  
  textInput.value = '';
  if (charCountSpan) charCountSpan.textContent = '0 字';
}

function addPrivateTextItem(item) {
  // 將定向私密文字加入本地私密歷史紀錄
  privateHistoryList.unshift(item);
  if (privateHistoryList.length > 20) privateHistoryList.pop();

  if (isWidgetMode) {
    updateWidgetOnDataChange();
  } else {
    const list = document.getElementById('text-history-list');
    const empty = list.querySelector('.empty-state');
    if (empty) empty.remove();
    
    const card = createTextCard(item);
    list.insertBefore(card, list.firstChild);
  }
}

// 更新全域共享歷史列表
function updateTextHistory(history) {
  globalTextHistory = history || [];

  if (isWidgetMode) {
    updateWidgetOnDataChange();
    return;
  }

  textHistoryList.innerHTML = '';
  if (globalTextHistory.length === 0) {
    textHistoryList.innerHTML = `
      <div class="empty-state">
        <i data-lucide="inbox"></i>
        <p>目前沒有共享的文字或網址</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  globalTextHistory.forEach(item => {
    const card = createTextCard(item);
    textHistoryList.appendChild(card);
  });
  
  lucide.createIcons();
}

// 狀態自動評估：當資料變更時重算小工具的最新卡片與歷史選單
function updateWidgetOnDataChange() {
  if (!isWidgetMode) return;
  console.log("[DataChange] updateWidgetOnDataChange() 被觸發 - 同步重新評估...");

  // 1. 刷新歷史清單
  renderWidgetHistoryList();

  // 2. 重算最新卡片：比較廣播文字、私密文字與伺服器檔案，找出時間戳最新的一筆
  const candidates = [];

  if (globalFileList && globalFileList.length > 0) {
    const latestFile = globalFileList.reduce((l, c) => c.uploadTime > l.uploadTime ? c : l, globalFileList[0]);
    candidates.push({ type: 'file', timestamp: latestFile.uploadTime, data: latestFile });
  }

  if (globalTextHistory && globalTextHistory.length > 0) {
    candidates.push({ type: 'text', timestamp: globalTextHistory[0].timestamp, data: globalTextHistory[0] });
  }

  if (privateHistoryList && privateHistoryList.length > 0) {
    candidates.push({ type: 'text', timestamp: privateHistoryList[0].timestamp, data: privateHistoryList[0] });
  }

  // 如果完全沒有資料
  if (candidates.length === 0) {
    if (widgetActiveCard) {
      widgetClipboardText.textContent = "等待接收內容...";
      widgetClipboardMeta.textContent = "無";
      widgetBtnCopy.style.display = 'none';
      widgetBtnOpen.style.display = 'none';
    }
    return;
  }

  // 排序找出最新一筆
  candidates.sort((a, b) => b.timestamp - a.timestamp);
  const latest = candidates[0];

  if (latest.type === 'file') {
    updateWidgetActiveCardWithFile(latest.data);
  } else {
    updateWidgetActiveCard(latest.data);
  }
}

// 渲染小工具專用「最新收到卡片」
function updateWidgetActiveCard(item) {
  if (!widgetActiveCard) return;

  widgetClipboardText.textContent = item.text;
  
  const displayTime = new Date(item.timestamp).toLocaleTimeString();
  let directionText = item.sender || 'Server';
  if (item.isPrivate) {
    const sender = item.sender === 'Me' ? 'Me' : item.sender;
    const receiver = item.targetNickname || 'Me';
    directionText = `${sender} ➔ ${receiver}`;
  }
  
  widgetClipboardMeta.textContent = `${displayTime} - ${directionText}`;
  
  widgetBtnCopy.style.display = 'inline-flex';
  widgetBtnOpen.removeAttribute('download');
  widgetBtnOpen.setAttribute('title', '在新分頁開啟');
  
  const icon = widgetBtnOpen.querySelector('i');
  if (icon) {
    icon.setAttribute('data-lucide', 'external-link');
  }

  const newCopyBtn = widgetBtnCopy.cloneNode(true);
  widgetBtnCopy.parentNode.replaceChild(newCopyBtn, widgetBtnCopy);
  newCopyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(item.text).then(() => {
      const icon = newCopyBtn.querySelector('i');
      icon.setAttribute('data-lucide', 'check');
      lucide.createIcons();
      setTimeout(() => {
        icon.setAttribute('data-lucide', 'copy');
        lucide.createIcons();
      }, 1500);
    });
  });

  const isUrl = isValidUrl(item.text);
  if (isUrl) {
    widgetBtnOpen.style.display = 'inline-flex';
    widgetBtnOpen.href = item.text;
  } else {
    widgetBtnOpen.style.display = 'none';
  }
  
  lucide.createIcons();
}

// 渲染小工具專用「最新暫存檔案卡片」
function updateWidgetActiveCardWithFile(file) {
  if (!widgetActiveCard) return;

  widgetClipboardText.textContent = `📁 暫存檔: ${file.originalName} (${formatBytes(file.size)})`;
  const displayTime = new Date(file.uploadTime).toLocaleTimeString();
  widgetClipboardMeta.textContent = `${displayTime} - 伺服器暫存`;

  widgetBtnCopy.style.display = 'none';

  widgetBtnOpen.style.display = 'inline-flex';
  widgetBtnOpen.href = `/api/download/${file.filename}`;
  widgetBtnOpen.setAttribute('download', file.originalName);
  widgetBtnOpen.setAttribute('title', '下載並從伺服器刪除');
  
  const icon = widgetBtnOpen.querySelector('i');
  if (icon) {
    icon.setAttribute('data-lucide', 'download');
    lucide.createIcons();
  }
}

// 渲染小工具專用「最新接收到的 P2P 檔案卡片」(使用本地 blob)
function updateWidgetActiveCardWithLocalFile(originalName, size, blobUrl) {
  if (!widgetActiveCard) return;

  widgetClipboardText.textContent = `📁 P2P 檔案: ${originalName} (${formatBytes(size)})`;
  widgetClipboardMeta.textContent = `${new Date().toLocaleTimeString()} - 來自 P2P 直連`;

  widgetBtnCopy.style.display = 'none';

  widgetBtnOpen.style.display = 'inline-flex';
  widgetBtnOpen.href = blobUrl;
  widgetBtnOpen.setAttribute('download', originalName);
  widgetBtnOpen.setAttribute('title', '下載檔案');
  
  const icon = widgetBtnOpen.querySelector('i');
  if (icon) {
    icon.setAttribute('data-lucide', 'download');
    lucide.createIcons();
  }
}

// 建立文字歷史卡片 (正常模式用)
function createTextCard(item) {
  const card = document.createElement('div');
  card.className = 'history-card';
  if (item.isPrivate) {
    card.classList.add('private');
  }
  
  const isUrl = isValidUrl(item.text);
  const textClass = isUrl ? 'card-text url' : 'card-text';
  const displayTime = new Date(item.timestamp).toLocaleTimeString();
  
  let directionText = item.sender || 'Server';
  if (item.isPrivate) {
    const sender = item.sender === 'Me' ? 'Me' : item.sender;
    const receiver = item.targetNickname || 'Me';
    directionText = `${sender} ➔ ${receiver}`;
  }

  card.innerHTML = `
    <div class="card-content">
      <div class="${textClass}" id="text-${item.id}">${escapeHtml(item.text)}</div>
      <div class="card-meta">
        <span><i data-lucide="clock" style="width:12px;height:12px;display:inline;"></i> ${displayTime}</span>
        <span>&bull;</span>
        <span>來源: ${directionText}</span>
        ${item.isPrivate ? `<span class="private-badge">定向</span>` : ''}
      </div>
    </div>
    <div class="card-actions">
      <button class="btn-icon btn-copy" title="複製內容">
        <i data-lucide="copy"></i>
      </button>
      ${isUrl ? `
        <button class="btn-icon btn-open-link" title="在新分頁開啟">
          <i data-lucide="external-link"></i>
        </button>
      ` : ''}
    </div>
  `;

  card.querySelector('.btn-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(item.text).then(() => {
      const copyIcon = card.querySelector('.btn-copy i');
      copyIcon.setAttribute('data-lucide', 'check');
      lucide.createIcons();
      setTimeout(() => {
        copyIcon.setAttribute('data-lucide', 'copy');
        lucide.createIcons();
      }, 1500);
    });
  });

  if (isUrl) {
    const openBtn = card.querySelector('.btn-open-link');
    const textNode = card.querySelector('.card-text.url');
    
    const openUrl = () => window.open(item.text, '_blank');
    if (openBtn) openBtn.addEventListener('click', openUrl);
    textNode.addEventListener('click', openUrl);
  }

  return card;
}

// 歷史下拉選單渲染 (Widget 模式專用：混合排序歷史紀錄)
function renderWidgetHistoryList() {
  if (!widgetHistoryList) return;
  widgetHistoryList.innerHTML = '';

  const listItems = [];

  globalTextHistory.forEach(item => {
    listItems.push({
      type: 'text',
      id: item.id,
      text: item.text,
      timestamp: item.timestamp,
      sender: item.sender || 'Server',
      isPrivate: false
    });
  });

  privateHistoryList.forEach(item => {
    listItems.push({
      type: 'text',
      id: item.id,
      text: item.text,
      timestamp: item.timestamp,
      sender: item.sender,
      isPrivate: true,
      targetNickname: item.targetNickname
    });
  });

  globalFileList.forEach(file => {
    listItems.push({
      type: 'file',
      id: file.filename,
      text: file.originalName,
      size: file.size,
      timestamp: file.uploadTime,
      filename: file.filename
    });
  });

  listItems.sort((a, b) => b.timestamp - a.timestamp);
  const displayItems = listItems.slice(0, 5);

  if (displayItems.length === 0) {
    widgetHistoryList.innerHTML = '<div style="text-align:center;font-size:0.7rem;color:var(--text-muted);padding:1rem;">無歷史紀錄</div>';
    return;
  }

  displayItems.forEach(item => {
    const div = document.createElement('div');
    div.className = 'widget-hist-item';
    const displayTime = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isUrl = item.type === 'text' && isValidUrl(item.text);
    
    let direction = item.sender;
    if (item.isPrivate) {
      direction = `${item.sender === 'Me' ? 'Me' : item.sender} ➔ ${item.targetNickname || 'Me'}`;
    }

    if (item.type === 'text') {
      const textClass = isUrl ? 'widget-hist-text url' : 'widget-hist-text';
      div.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div class="${textClass}" title="${escapeHtml(item.text)}">${escapeHtml(item.text)}</div>
          <div class="widget-hist-meta">${displayTime} &bull; ${direction}</div>
        </div>
        <div class="widget-hist-actions">
          <button class="btn-icon btn-hist-copy" title="複製內容"><i data-lucide="copy"></i></button>
          ${isUrl ? `<a href="${item.text}" target="_blank" class="btn-icon" title="打開網址"><i data-lucide="external-link"></i></a>` : ''}
        </div>
      `;

      div.querySelector('.btn-hist-copy').addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(item.text).then(() => {
          showToast('已複製到剪貼簿！', 'success');
        });
      });

      if (isUrl) {
        const openInExternal = (e) => {
          e.stopPropagation();
          if (isWidgetMode && window.pywebview && window.pywebview.api) {
            e.preventDefault();
            window.pywebview.api.open_in_browser(item.text);
          } else {
            window.open(item.text, '_blank');
          }
        };
        div.querySelector('.widget-hist-text.url').addEventListener('click', openInExternal);
        const linkBtn = div.querySelector('a[title="打開網址"]');
        if (linkBtn) linkBtn.addEventListener('click', openInExternal);
      }

    } else if (item.type === 'file') {
      div.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div class="widget-hist-text" style="font-weight:600;" title="${escapeHtml(item.text)}">📁 ${escapeHtml(item.text)}</div>
          <div class="widget-hist-meta">${displayTime} &bull; 暫存 (${formatBytes(item.size)})</div>
        </div>
        <div class="widget-hist-actions">
          <a href="/api/download/${item.filename}" class="btn-icon" download="${escapeHtml(item.text)}" title="下載並從伺服器刪除">
            <i data-lucide="download"></i>
          </a>
        </div>
      `;
      
      const dlBtn = div.querySelector('a');
      if (dlBtn) {
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isWidgetMode && window.pywebview && window.pywebview.api) {
            e.preventDefault();
            const downloadName = dlBtn.getAttribute('download') || item.text;
            window.pywebview.api.download_file_via_python(dlBtn.getAttribute('href'), downloadName);
          }
        });
      }
    }

    widgetHistoryList.appendChild(div);
  });

  lucide.createIcons();
}

// 更新檔案清單 UI
function updateFileList(files) {
  globalFileList = files || [];

  if (isWidgetMode) {
    updateWidgetOnDataChange();
    return;
  }

  sharedFileList.innerHTML = '';
  if (globalFileList.length === 0) {
    sharedFileList.innerHTML = `
      <div class="empty-state">
        <i data-lucide="file-warning"></i>
        <p>目前沒有共享的檔案</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  globalFileList.forEach(file => {
    const card = document.createElement('div');
    card.className = 'file-card';
    const displaySize = formatBytes(file.size);
    const displayTime = new Date(file.uploadTime).toLocaleTimeString();

    card.innerHTML = `
      <div class="card-content">
        <div class="card-text" style="font-weight: 600;">${escapeHtml(file.originalName)}</div>
        <div class="card-meta">
          <span>大小: ${displaySize}</span>
          <span>&bull;</span>
          <span>時間: ${displayTime}</span>
        </div>
      </div>
      <div class="card-actions">
        <a href="/api/download/${file.filename}" class="btn-icon" download title="下載並從伺服器刪除">
          <i data-lucide="download"></i>
        </a>
        <button class="btn-icon btn-icon-danger btn-delete-file" title="刪除檔案">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    `;

    card.querySelector('.btn-delete-file').addEventListener('click', () => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'delete-file',
          filename: file.filename
        }));
      }
    });

    sharedFileList.appendChild(card);
  });

  lucide.createIcons();
}

// 進度條 UI
function showProgressUI(filename) {
  if (progressContainer) {
    progressContainer.classList.remove('hidden');
    progressFilename.textContent = filename;
  }
}

function updateProgressUI(percent) {
  if (progressPercent) progressPercent.textContent = `${percent}%`;
  if (progressFill) progressFill.style.width = `${percent}%`;
}

function hideProgressUI() {
  if (progressContainer) {
    progressContainer.classList.add('hidden');
    progressPercent.textContent = '0%';
    progressFill.style.width = '0%';
  }
}

// 8. 萬能輸入框檔案選擇處理
if (dropzone) {
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFilesSelection(files);
    }
  });

  dropzone.addEventListener('click', () => {
    fileInput.click();
  });
}

if (fileInput) {
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      handleFilesSelection(fileInput.files);
    }
  });
}

function handleFilesSelection(files) {
  const file = files[0];
  if (!file) return;

  const fileTargetVal = isWidgetMode ? globalTargetSelect.value : fileTargetSelect.value;

  if (fileTargetVal === 'all' || fileTargetVal === 'server') {
    uploadFileToServer(file);
  } else {
    const targetConn = rtcConnections.get(fileTargetVal);
    
    if (targetConn && targetConn.dc && targetConn.dc.readyState === 'open') {
      sendFileP2P(file, targetConn.dc);
    } else {
      alert(`連線狀態未就緒！無法直接傳送檔案給該裝置。請切換為「廣播」模式傳送。`);
    }
  }
}

// 上傳檔案至伺服器
function uploadFileToServer(file) {
  const formData = new FormData();
  formData.append('file', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload', true);

  showProgressUI(file.name);
  showToast('正在上傳檔案至伺服器...', 'info');

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const percent = Math.round((e.loaded / e.total) * 100);
      updateProgressUI(percent);
    }
  };

  xhr.onload = () => {
    hideProgressUI();
    if (xhr.status === 200) {
      showToast('檔案已廣播上傳成功！', 'success');
    } else {
      showToast('上傳失敗：' + xhr.statusText, 'error');
    }
  };

  xhr.onerror = () => {
    hideProgressUI();
    showToast('上傳發生網路錯誤。', 'error');
  };

  xhr.send(formData);
}

// 9. 輔助功能
function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// 10. 啟動與暱稱初始化
initLocalNickname();
initWebSocket();

// 註冊 Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.log('SW registration failed: ', err);
    });
  });
}

// 全域監聽小工具打開/下載按鈕，優先使用 Python JS API 喚醒系統外部瀏覽器進行下載/開啟
if (widgetBtnOpen) {
  widgetBtnOpen.addEventListener('click', (e) => {
    if (isWidgetMode && window.pywebview && window.pywebview.api) {
      const href = widgetBtnOpen.getAttribute('href');
      if (href && !href.startsWith('#') && href !== '') {
        e.preventDefault();
        
        // 分流：如果有 download 屬性，走 python 默默下載
        if (widgetBtnOpen.hasAttribute('download')) {
          const downloadName = widgetBtnOpen.getAttribute('download') || 'downloaded_file';
          window.pywebview.api.download_file_via_python(href, downloadName);
        } else {
          // 否則走外部瀏覽器開啟 (如開啟網址)
          window.pywebview.api.open_in_browser(href);
        }
      }
    }
  });
}
