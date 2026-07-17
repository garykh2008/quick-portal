// 判定 API 伺服器主機位址 (Tauri 客戶端中會自動連線到您的 VDS 公網伺服器，網頁中則自動連線到當前主機)
const REMOTE_SERVER = 'http://159.223.86.218:5001';
let SERVER_HOST = '';
{
  const h = window.location.hostname;
  const proto = window.location.protocol;
  // 優雅且 100% 絕對可靠的判定：只要有 window.__TAURI__ (Tauri 注入的全域變數) 或特定 protocol，一律視為小工具，連向 VDS
  if (window.__TAURI__ || h === 'tauri.localhost' || proto === 'tauri:' || proto === 'file:') {
    SERVER_HOST = REMOTE_SERVER;
  } else {
    SERVER_HOST = window.location.origin;
  }
}

// 產生帶有 ?username= 的 API URL，用於繞過 SameSite Cookie 跨域限制
// 在 HTTP（非 HTTPS）環境下，Set-Cookie SameSite=None 無法生效，
// 改以 query string 攜帶身份，伺服器的 getUsernameFromReq() 已支援此方式
function apiUrl(path) {
  const user = currentUser || '';
  const sep = path.includes('?') ? '&' : '?';
  return SERVER_HOST + path + (user ? sep + 'username=' + encodeURIComponent(user) : '');
}

// 全局變數
let socket;
let clientId = null;
let myNickname = '';
let activePeers = 0;
let peerList = []; // 格式：[{ ip, name, isOnline }]
let connectionMode = 'server'; // 'server' 或 'p2p'
let currentUser = null; // 當前登入的使用者帳號

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
const windowCloseBtn = document.getElementById('window-close-btn');
const windowMinimizeBtn = document.getElementById('window-minimize-btn');
const bubbleContainer = document.getElementById('bubble-container');
const bubbleInner = document.getElementById('bubble-inner');
const bubbleBadge = document.getElementById('bubble-badge');

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

// 認證與裝置 DOM
const authStatusContainer = document.getElementById('auth-status-container');
const authDisplayName = document.getElementById('auth-display-name');
const btnAuthLogout = document.getElementById('btn-auth-logout');
const authModal = document.getElementById('auth-modal');
const authForm = document.getElementById('auth-form');
const authInputUser = document.getElementById('auth-input-user');
const authInputPass = document.getElementById('auth-input-pass');
const authErrorMsg = document.getElementById('auth-error-msg');
const btnAuthSubmit = document.getElementById('btn-auth-submit');
const linkAuthToggle = document.getElementById('link-auth-toggle');
const authToggleText = document.getElementById('auth-toggle-text');
const authModalTitle = document.getElementById('auth-modal-title');
const deviceDropdown = document.getElementById('device-dropdown');
const deviceListContainer = document.getElementById('device-list-container');
const widgetStatusBar = document.getElementById('widget-status-bar');

// 裝置清單下拉與外部點擊關閉
// 裝置清單下拉與外部點擊關閉
if (peerCountBadge && deviceDropdown) {
  peerCountBadge.addEventListener('click', (e) => {
    e.stopPropagation();
    deviceDropdown.classList.toggle('active');
    
    // 小工具模式下的動態高度調整
    if (isWidgetMode) {
      fitWindowToContent();
    }
  });
  
  document.addEventListener('click', () => {
    deviceDropdown.classList.remove('active');
    // 外部點擊收起時自適應調整
    if (isWidgetMode) {
      fitWindowToContent();
    }
  });
  
  deviceDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

let isRegistering = false;

if (linkAuthToggle) {
  linkAuthToggle.addEventListener('click', (e) => {
    e.preventDefault();
    isRegistering = !isRegistering;
    if (isRegistering) {
      authModalTitle.innerHTML = '<i data-lucide="user-plus"></i> 使用者註冊';
      btnAuthSubmit.textContent = '註冊並登入';
      authToggleText.textContent = '已有帳號？';
      linkAuthToggle.textContent = '立即登入';
    } else {
      authModalTitle.innerHTML = '<i data-lucide="user-check"></i> 使用者登入';
      btnAuthSubmit.textContent = '登入';
      authToggleText.textContent = '沒有帳號？';
      linkAuthToggle.textContent = '立即註冊';
    }
    authErrorMsg.classList.add('hidden');
    lucide.createIcons();
  });
}

if (btnAuthSubmit) {
  btnAuthSubmit.addEventListener('click', async () => {
    const username = authInputUser.value.trim();
    const password = authInputPass.value;
    if (!username || !password) return;

    // login/register 不能用 apiUrl() 因為 currentUser 還不存在，直接帶 username 在 body 即可
    const url = SERVER_HOST + (isRegistering ? '/api/auth/register' : '/api/auth/login');
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok && data.success) {
        currentUser = data.username;
        authModal.classList.add('hidden');
        if (isWidgetMode) {
          if (widgetStatusBar) widgetStatusBar.style.display = 'flex';
          fitWindowToContent();
        }
        showToast(isRegistering ? '註冊成功並登入' : '登入成功', 'success');
        
        // 更新 UI 顯示
        authDisplayName.textContent = currentUser;
        btnAuthLogout.style.display = 'inline';
        
        // 觸發 WebSoket 連線
        initWebSocket();
      } else {
        authErrorMsg.textContent = data.error || '認證失敗';
        authErrorMsg.classList.remove('hidden');
      }
    } catch (err) {
      console.error(err);
      authErrorMsg.textContent = '伺服器連線失敗';
      authErrorMsg.classList.remove('hidden');
    }
  });
}

if (btnAuthLogout) {
  btnAuthLogout.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      await fetch(apiUrl('/api/auth/logout'), { method: 'POST' });
      currentUser = null;
      authDisplayName.textContent = '未登入';
      btnAuthLogout.style.display = 'none';
      if (socket) socket.close();
      checkAuthStatus();
    } catch (err) {
      console.error(err);
    }
  });
}

// 檢查使用者認證狀態
async function checkAuthStatus() {
  try {
    const res = await fetch(apiUrl('/api/auth/me'));
    const data = await res.json();
    if (data.loggedIn) {
      currentUser = data.username;
      authDisplayName.textContent = currentUser;
      btnAuthLogout.style.display = 'inline';
      authModal.classList.add('hidden');
      if (isWidgetMode) {
        if (widgetStatusBar) widgetStatusBar.style.display = 'flex';
        fitWindowToContent();
      }
      initWebSocket();
    } else {
      currentUser = null;
      authDisplayName.textContent = '未登入';
      btnAuthLogout.style.display = 'none';
      authModal.classList.remove('hidden');
      if (isWidgetMode) {
        if (widgetStatusBar) widgetStatusBar.style.display = 'none';
        fitWindowToContent(); // 自動貼合登入 Modal 高度
      }
    }
  } catch (err) {
    console.error('Check auth failed:', err);
    // 連線/跨域失敗時的安全性降級處理：彈出登入畫面阻斷
    currentUser = null;
    authDisplayName.textContent = '連線失敗';
    btnAuthLogout.style.display = 'none';
    authModal.classList.remove('hidden');
    if (isWidgetMode) {
      if (widgetStatusBar) widgetStatusBar.style.display = 'none';
      fitWindowToContent();
    }
  }
}

// 渲染裝置清單抽屜
function renderDeviceList(peers) {
  if (!deviceListContainer) return;
  if (peers.length === 0) {
    deviceListContainer.innerHTML = '<div class="loading-placeholder">目前無其他登錄裝置</div>';
    return;
  }

  deviceListContainer.innerHTML = '';
  peers.forEach(peer => {
    const isSelf = peer.deviceId === clientId;
    const isOnline = peer.isOnline;
    
    const item = document.createElement('div');
    item.className = 'device-item';
    item.innerHTML = `
      <div class="device-info">
        <div class="device-meta-row">
          <div class="device-status-dot ${isOnline ? 'online' : ''}" title="${isOnline ? '在線' : '離線'}"></div>
          <span class="device-name-container" title="${peer.name}">${peer.name}</span>
          ${isSelf ? '<span class="device-item-self">本機</span>' : ''}
        </div>
        <span class="device-ip">${peer.ip}</span>
      </div>
      <div class="device-actions">
        <button class="btn-icon btn-rename-device" data-id="${peer.deviceId}" data-name="${peer.name}" title="修改暱稱">
          <i data-lucide="edit-3"></i>
        </button>
        ${!isSelf ? `
          <button class="btn-icon btn-delete-device" data-id="${peer.deviceId}" title="刪除裝置">
            <i data-lucide="trash-2"></i>
          </button>
        ` : ''}
      </div>
    `;
    deviceListContainer.appendChild(item);
  });

  lucide.createIcons();

  // 綁定暱稱修改事件
  deviceListContainer.querySelectorAll('.btn-rename-device').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const deviceId = btn.getAttribute('data-id');
      const oldName = btn.getAttribute('data-name');
      showCustomPromptModal('修改裝置名稱', '請輸入新的裝置暱稱:', oldName, async (newName) => {
        if (newName && newName.trim() && newName !== oldName) {
          try {
            const res = await fetch(apiUrl('/api/auth/device/rename'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ deviceId, name: newName.trim() })
            });
            const data = await res.json();
            if (data.success) {
              showToast('暱稱修改成功', 'success');
              if (deviceId === clientId && localNicknameInput) {
                localNicknameInput.value = newName.trim();
                myNickname = newName.trim();
              }
            } else {
              showToast(data.error || '暱稱修改失敗', 'error');
            }
          } catch (err) {
            console.error(err);
          }
        }
      });
    });
  });

  // 綁定刪除裝置事件
  deviceListContainer.querySelectorAll('.btn-delete-device').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const deviceId = btn.getAttribute('data-id');
      showCustomConfirmModal('解綁裝置', `確認要解綁並刪除該裝置嗎？`, async () => {
        try {
          const res = await fetch(apiUrl('/api/auth/device/delete'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId })
          });
          const data = await res.json();
          if (data.success) {
            showToast('裝置刪除成功', 'success');
          } else {
            showToast(data.error || '裝置刪除失敗', 'error');
          }
        } catch (err) {
          console.error(err);
        }
      });
    });
  });
}

// 1. 初始化與模式判斷
const urlParams = new URLSearchParams(window.location.search);
const isWidgetMode = urlParams.get('mode') === 'widget' || window.innerWidth < 450 || window.location.pathname.includes('widget.html');

if (isWidgetMode) {
  document.body.classList.add('tab-send'); // 雙重保險：小工具初始化時為 body 加上預設發送分頁 class，以啟用接收紅點提示
}

// 如果是在小工具模式下，強力註銷所有已註冊的 Service Worker，並清除其快取，以防 WebView2 載入舊版快取資源或引發自訂協議載入異常
if (isWidgetMode && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    for (let registration of registrations) {
      registration.unregister().then(() => {
        console.log('[Tauri SW] 已註銷殘留的 Service Worker 舊快取！');
      });
    }
  });
}

// Tauri 視窗自適應大小伸縮 (無邊框且防止網頁內容被視窗邊界截斷)
function tauriResizeWindow(height) {
  if (window.__TAURI__ && window.__TAURI__.core) {
    window.__TAURI__.core.invoke('resize_window', { height: height });
  }
}

// 根據 DOM 實際渲染高度，自動調整 OS 視窗高度 (100% 解決硬編碼截斷問題)
function fitWindowToContent() {
  // 如果處於懸浮球氣泡模式下，嚴禁調整視窗高度，防止氣泡被上下裁剪壓扁！
  if (document.body.classList.contains('mode-bubble')) return;

  if (isWidgetMode && window.__TAURI__) {
    // 延遲 50ms 確保 DOM layout 已經重新計算完成
    setTimeout(() => {
      const container = document.getElementById('app');
      if (container) {
        // 如果尚未完成登入認證，或是登入 Modal 正在顯示，視窗高度一律維持在 294px 的精確安全高度
        // 這 100% 保證啟動與登入期間卡片不會被截斷，且拖曳欄與關閉 X 按鈕完全可見可點選，並保留了優雅對稱的上下呼吸邊界
        const authModal = document.getElementById('auth-modal');
        if (!currentUser || (authModal && !authModal.classList.contains('hidden'))) {
          console.log('[Tauri Layout] 偵測到處於未登入狀態，將視窗高度鎖定在 310px (294px 卡片 + 16px 外縮 margin)');
          tauriResizeWindow(310);
          return;
        }
        // 取得 app 容器的真實物理高度，並加上 16px 的 Margin 緩衝空間防止溢出截斷
        const height = Math.ceil(container.getBoundingClientRect().height);
        console.log('[Tauri Layout] 偵測到已登入，動態伸縮適應高度為 (含 margin):', height + 16);
        tauriResizeWindow(height + 16);
      }
    }, 50);
  }
}

if (isWidgetMode) {
  document.body.classList.add('widget-mode');
  document.body.classList.add('tab-send'); // 預設為傳送分頁
  if (modeBadge) modeBadge.textContent = '懸浮小工具';
  if (textInput) textInput.setAttribute('rows', '1');
  fitWindowToContent(); // 啟動時根據 DOM 內容自動調整高度
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
    if (deviceDropdown) deviceDropdown.classList.remove('active');
    fitWindowToContent(); // 自動貼合傳送內容高度
  });

  tabBtnReceive.addEventListener('click', () => {
    tabBtnReceive.classList.add('active');
    tabBtnSend.classList.remove('active');
    document.body.classList.remove('tab-send');
    document.body.classList.add('tab-receive');
    const dot = document.getElementById('unread-dot');
    if (dot) {
      dot.classList.add('hidden'); // 切換到接收頁即清除未讀紅點
      dot.style.display = 'none';
    }
    if (deviceDropdown) deviceDropdown.classList.remove('active');
    updateWidgetOnDataChange(); // 切換時主動刷新與重算狀態
    fitWindowToContent(); // 自動貼合接收內容高度
  });
}

// 小工具關閉按鈕事件監聽 (Tauri 全域 API 關閉視窗)
if (windowCloseBtn) {
  console.log('[Tauri Init] 關閉按鈕 DOM 已尋獲，正在綁定事件。');
  windowCloseBtn.addEventListener('click', (e) => {
    console.log('[Tauri Trigger] 關閉按鈕被點擊！');
    e.stopPropagation();
    try {
      if (window.__TAURI__ && window.__TAURI__.core) {
        console.log('[Tauri Trigger] 正在呼叫 Rust close_window 命令');
        window.__TAURI__.core.invoke('close_window');
      } else {
        console.warn('[Tauri Trigger] 未檢測到 Tauri 環境，使用 window.close() 退路方式');
        window.close();
      }
    } catch (err) {
      console.error('[Tauri Trigger] 關閉視窗拋出錯誤：', err);
    }
  });
} else {
  console.error('[Tauri Init] 找不到關閉按鈕 DOM (#window-close-btn)！');
}

// 小工具最小化為懸浮氣泡事件監聽
if (windowMinimizeBtn) {
  windowMinimizeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    try {
      if (window.__TAURI__ && window.__TAURI__.core) {
        // 1. 設置視窗為 64x64 像素
        window.__TAURI__.core.invoke('resize_window', { width: 64, height: 64 });
        // 2. 設定視窗永遠置頂 (Always on Top)
        window.__TAURI__.core.invoke('set_always_on_top', { onTop: true });
        // 3. 切換網頁 class 為氣泡模式
        document.body.classList.add('mode-bubble');
        document.documentElement.classList.add('mode-bubble');
      }
    } catch (err) {
      console.error('[Tauri Minimize] 縮小成氣泡失敗:', err);
    }
  });
}

// 點擊懸浮氣泡展開還原事件監聽 (重大重構：採用拖曳與點擊高靈敏度分流算法，徹底解決氣泡點擊不靈敏的問題)
if (bubbleInner) {
  let isDragging = false;
  let startX = 0;
  let startY = 0;

  bubbleInner.addEventListener('mousedown', (e) => {
    if (e.buttons === 1) { // 僅限左鍵
      isDragging = false;
      startX = e.screenX;
      startY = e.screenY;

      const onMouseMove = (moveEvent) => {
        const deltaX = Math.abs(moveEvent.screenX - startX);
        const deltaY = Math.abs(moveEvent.screenY - startY);
        // 如果滑鼠位移超過 3 像素，判定為使用者正在拖曳懸浮球
        if (deltaX > 3 || deltaY > 3) {
          isDragging = true;
          window.removeEventListener('mousemove', onMouseMove);
          try {
            if (window.__TAURI__ && window.__TAURI__.window) {
              window.__TAURI__.window.getCurrentWindow().startDragging();
            }
          } catch (err) {
            console.error('[Tauri Drag] 氣泡開始拖曳失敗:', err);
          }
        }
      };

      const onMouseUp = () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        // 如果滑鼠按下到放開期間沒有位移（或是位移極小），100% 判定為點擊展開！
        if (!isDragging) {
          console.log('[Tauri Bubble] 檢測到精確輕點，執行展開還原');
          try {
            if (window.__TAURI__ && window.__TAURI__.core) {
              // 1. 取消視窗永遠置頂
              window.__TAURI__.core.invoke('set_always_on_top', { onTop: false });
              // 2. 切換網頁 class 為正常模式 (讓 #app 容器顯示)
              document.body.classList.remove('mode-bubble');
              document.documentElement.classList.remove('mode-bubble');
              // 3. 隱藏氣泡上的未讀紅點
              if (bubbleBadge) {
                bubbleBadge.classList.add('hidden');
              }
              
              // 4. 預先將視窗擴展至安全的高度，再進行延遲適應重算，解決 Layout Reflow 髒高導致的扁平截斷問題
              const authModal = document.getElementById('auth-modal');
              const isNotLoggedIn = !currentUser || (authModal && !authModal.classList.contains('hidden'));
              
              if (isNotLoggedIn) {
                // 未登入：直接還原為穩定的 310px 預設安全高度 (294px 卡片 + 16px margin)
                window.__TAURI__.core.invoke('resize_window', { width: 320, height: 310 });
              } else {
                // 已登入：先撐開為 366px，給予 DOM 180ms 重排時間後再自適應調整 (350px 卡片 + 16px margin)
                window.__TAURI__.core.invoke('resize_window', { width: 320, height: 366 });
                setTimeout(() => {
                  fitWindowToContent();
                }, 180);
              }
            }
          } catch (err) {
            console.error('[Tauri Expand] 展開還原視窗失敗:', err);
          }
        }
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }
  });
}

// 未讀通知紅點觸發函式 (加強 log 便於排查)
function triggerUnreadDot() {
  const dot = document.getElementById('unread-dot');
  const bubbleDot = document.getElementById('bubble-badge');
  const isTabSend = document.body.classList.contains('tab-send');
  const isModeBubble = document.body.classList.contains('mode-bubble');
  
  console.log(`[Unread] triggerUnreadDot() 被觸發 - isWidgetMode: ${isWidgetMode}, in tab-send: ${isTabSend}`);
  console.log(`[Unread] dot DOM:`, dot, `bubbleDot DOM:`, bubbleDot);

  if (isWidgetMode) {
    // 狀況 A：如果處於懸浮球氣泡模式下，顯示氣泡紅色角標
    if (isModeBubble) {
      if (bubbleDot) {
        bubbleDot.classList.remove('hidden');
        bubbleDot.style.display = 'block';
        console.log("[Unread] 氣泡紅點已顯示");
      }
    }
    // 狀況 B：如果處於主視窗且在發送頁面，顯示接收按鈕紅點
    if (isTabSend) {
      if (dot) {
        dot.classList.remove('hidden');
        dot.style.display = 'block';
        console.log("[Unread] 接收分頁紅點已顯示");
      }
    }
  }
}

// 2. Toast 提示通知函式
function showToast(message, type = 'info') {
  // 解決小氣泡模式下彈 Toast 的問題 (氣泡太小會導致 Toast 嚴重變形截斷，且會阻擋對氣泡的點擊點選)
  if (isWidgetMode && document.body.classList.contains('mode-bubble')) {
    return;
  }
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
  // 依據是否為小工具模式，自動為預設名稱加上後綴，讓使用者能一秒看清 Chrome 與桌面端的區別
  if (isWidgetMode) {
    return `${os}-Widget-${randId}`;
  } else {
    return `${os}-Web-${randId}`;
  }
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
  const wsProtocol = SERVER_HOST.startsWith('https:') ? 'wss:' : 'ws:';
  const wsHost = SERVER_HOST.replace(/^https?:\/\//, '');
  const wsUrl = `${wsProtocol}//${wsHost}/?deviceId=${deviceId}&username=${encodeURIComponent(currentUser || '')}&nickname=${encodeURIComponent(myNickname)}`;
  
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    updateStatus('online', '已連線至伺服器');
    connectionInfo.textContent = `Server: ${wsHost}`;
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
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      console.error('WebSocket Message parse error:', err);
      return;
    }
    
    // 若收到需要認證的訊息，直接彈出 Modal 阻斷
    if (data.type === 'require-auth') {
      currentUser = null;
      authDisplayName.textContent = '未登入';
      btnAuthLogout.style.display = 'none';
      authModal.classList.remove('hidden');
      if (isWidgetMode) {
        if (widgetStatusBar) widgetStatusBar.style.display = 'none';
        fitWindowToContent();
      }
      if (socket) socket.close();
      return;
    }
    
    switch (data.type) {
      case 'init':
        clientId = data.clientId; 
        activePeers = data.activePeers;
        
        // 優先使用後端資料庫登記的最新自訂暱稱，更新本地變數與 UI
        if (data.nickname) {
          myNickname = data.nickname;
          localStorage.setItem('quick-portal-nickname', myNickname);
          if (localNicknameInput) {
            localNicknameInput.value = myNickname;
          }
        }
        
        // 安全初始化 peerList，解決 init 與 peer-update 的 Race Condition
        if (data.peers) {
          peerList = data.peers.filter(p => p.deviceId !== clientId);
        }
        if (data.deviceList) {
          renderDeviceList(data.deviceList);
        }
        
        updatePeerCount(activePeers);
        updateTextHistory(data.textHistory);
        updateFileList(data.files);
        
        // 立即發起 WebRTC 直連連線
        updateTargetSelectors();
        manageRTCConnections();
        
        isInitDone = true; // 初始化完畢，開始監聽未讀
        triggerUnreadDot();
        break;

      case 'peer-update':
        activePeers = data.activePeers;
        peerList = data.peers.filter(p => p.deviceId !== clientId);
        updatePeerCount(activePeers);
        
        // 渲染下拉裝置面板
        if (data.deviceList) {
          renderDeviceList(data.deviceList);
        }
        
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
    const state = pc.connectionState;
    console.log(`[RTC] Connection state with ${targetPeerId}: ${state}`);
    if (state === 'failed') {
      showToast(`P2P 直連失敗 (同台電腦受限，請改用 Server 暫存)`, 'warning');
    } else if (state === 'connected') {
      showToast(`P2P 直連已開通！`, 'success');
    }
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
        const state = pc.connectionState;
        console.log(`[RTC] Connection state with ${senderPeerId}: ${state}`);
        if (state === 'failed') {
          showToast(`P2P 直連失敗 (同台電腦受限，請改用 Server 暫存)`, 'warning');
        } else if (state === 'connected') {
          showToast(`P2P 直連已開通！`, 'success');
        }
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

      case 'p2p-file-request':
        const reqTransferId = msg.transferId;
        const reqFilename = msg.filename;
        const reqSize = msg.size;
        const reqSender = getPeerNickname(peerId);
        
        // 使用自訂的 HTML Modal 代替瀏覽器 Native Confirm，防超小視窗截斷且視覺精美
        showP2pConfirmModal(reqSender, reqFilename, reqSize, () => {
          // 同意回呼 (Accept)
          fileTransfers[reqTransferId] = {
            filename: reqFilename,
            size: reqSize,
            receivedSize: 0,
            chunks: [],
            peerId: peerId
          };
          const conn = rtcConnections.get(peerId);
          if (conn && conn.dc && conn.dc.readyState === 'open') {
            conn.dc.send(JSON.stringify({
              type: 'p2p-file-accept',
              transferId: reqTransferId
            }));
          }
        }, () => {
          // 拒絕回呼 (Reject)
          const conn = rtcConnections.get(peerId);
          if (conn && conn.dc && conn.dc.readyState === 'open') {
            conn.dc.send(JSON.stringify({
              type: 'p2p-file-reject',
              transferId: reqTransferId
            }));
          }
        });
        break;

      case 'p2p-file-accept':
        const acceptTransferId = msg.transferId;
        const acceptFile = pendingFileSends.get(acceptTransferId);
        const activeConn = rtcConnections.get(peerId);
        if (acceptFile && activeConn && activeConn.dc && activeConn.dc.readyState === 'open') {
          sendFileP2P(acceptFile, activeConn.dc, acceptTransferId);
          pendingFileSends.delete(acceptTransferId);
        }
        break;

      case 'p2p-file-reject':
        const rejectTransferId = msg.transferId;
        const rejectFile = pendingFileSends.get(rejectTransferId);
        if (rejectFile) {
          showToast(`對方拒絕接收檔案「${rejectFile.name}」`, 'error');
          pendingFileSends.delete(rejectTransferId);
        }
        break;

      case 'file-start':
        const transferId = msg.transferId;
        // 如果前面 confirm 後還沒有初始化，在此予以防呆初始化
        if (!fileTransfers[transferId]) {
          fileTransfers[transferId] = {
            filename: msg.filename,
            size: msg.size,
            receivedSize: 0,
            chunks: [],
            peerId: peerId
          };
        }
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

// 暫存 P2P 直連傳送任務
const pendingFileSends = new Map();

// P2P 檔案傳輸請求發起 (先尋求接收端確認同意)
function requestSendFileP2P(file, dc) {
  const transferId = `tf-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
  pendingFileSends.set(transferId, file);
  
  dc.send(JSON.stringify({
    type: 'p2p-file-request',
    transferId,
    filename: file.name,
    size: file.size
  }));
  
  showToast(`等待對方接受檔案「${file.name}」...`, 'info');
}

// P2P 檔案分片傳送 (改由對方確認同意後呼叫)
async function sendFileP2P(file, dc, transferId) {
  const tid = transferId || `tf-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
  const CHUNK_SIZE = 16384; 
  
  dc.send(JSON.stringify({
    type: 'file-start',
    transferId: tid,
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
    fitWindowToContent();
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
  fitWindowToContent();
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

  const currentCopyBtn = document.getElementById('widget-btn-copy');
  if (currentCopyBtn) {
    const newCopyBtn = currentCopyBtn.cloneNode(true);
    currentCopyBtn.parentNode.replaceChild(newCopyBtn, currentCopyBtn);
    newCopyBtn.addEventListener('click', () => {
      copyTextToClipboard(item.text).then(() => {
        showToast('已複製到剪貼簿！', 'success');
        const icon = newCopyBtn.querySelector('i');
        icon.setAttribute('data-lucide', 'check');
        lucide.createIcons();
        setTimeout(() => {
          icon.setAttribute('data-lucide', 'copy');
          lucide.createIcons();
        }, 1500);
      });
    });
  }

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
  widgetBtnOpen.href = apiUrl(`/api/download/${file.filename}`);
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
    copyTextToClipboard(item.text).then(() => {
      showToast('已複製到剪貼簿！', 'success');
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
        copyTextToClipboard(item.text).then(() => {
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
          <button class="btn-icon btn-dl-server" data-url="${apiUrl('/api/download/' + item.filename)}" data-name="${escapeHtml(item.text)}" title="下載並從伺服器刪除">
            <i data-lucide="download"></i>
          </button>
        </div>
      `;
      
      const dlBtn = div.querySelector('.btn-dl-server');
      if (dlBtn) {
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          downloadFromServer(dlBtn.dataset.url, dlBtn.dataset.name);
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
        <button class="btn-icon btn-dl-server" data-url="${apiUrl('/api/download/' + file.filename)}" data-name="${escapeHtml(file.originalName)}" title="下載並從伺服器刪除">
          <i data-lucide="download"></i>
        </button>
        <button class="btn-icon btn-icon-danger btn-delete-file" title="刪除檔案">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    `;

    card.querySelector('.btn-dl-server').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      downloadFromServer(btn.dataset.url, btn.dataset.name);
    });

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
      requestSendFileP2P(file, targetConn.dc);
    } else {
      const state = (targetConn && targetConn.pc) ? targetConn.pc.connectionState : '未發起';
      const dcState = (targetConn && targetConn.dc) ? targetConn.dc.readyState : '無通道';
      alert(`【P2P 直連未就緒】\n當前 WebRTC 狀態：${state} (DataChannel: ${dcState})\n\n說明：\n1. 若您是在「同台電腦」上同時開啟大網頁和小工具，因瀏覽器安全沙盒限制本機迴環，P2P 直連將無法建立，請選擇「☁️ 上傳至 Server 暫存」對傳。\n2. 若是跨裝置，請確認兩台電腦在同一個區域網路，且防火牆未封鎖 UDP 傳輸。`);
    }
  }
}

// 上傳檔案至伺服器
function uploadFileToServer(file) {
  const formData = new FormData();
  formData.append('file', file);

  const xhr = new XMLHttpRequest();
  xhr.withCredentials = true;
  xhr.open('POST', apiUrl('/api/upload'), true);

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

// 跨瀏覽器複製剪貼簿支援 (包含在公網 HTTP 等非安全上下文環境下使用的 execCommand 後備方案)
function copyTextToClipboard(text) {
  return new Promise((resolve, reject) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(resolve).catch(err => {
        fallbackCopyText(text) ? resolve() : reject(err);
      });
    } else {
      fallbackCopyText(text) ? resolve() : reject(new Error('Copy not supported'));
    }
  });
}

function fallbackCopyText(text) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.top = '0';
  textArea.style.left = '0';
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    return successful;
  } catch (err) {
    console.error('Fallback copy failed:', err);
    document.body.removeChild(textArea);
    return false;
  }
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

// 10. 啟動與暱稱及認證初始化
initLocalNickname();
if (typeof lucide !== 'undefined') {
  lucide.createIcons();
}

// 解決 Linux (WebKit2GTK) 下 data-tauri-drag-region 無法拖曳視窗的相容性 Bug (呼叫 Tauri 本地視窗拖曳 API)
if (window.__TAURI__ && window.__TAURI__.window) {
  try {
    const { getCurrentWindow } = window.__TAURI__.window;
    const appWindow = getCurrentWindow();
    document.querySelectorAll('[data-tauri-drag-region]').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        if (e.buttons === 1) { // 左鍵按下時才拖曳
          // 防呆：點擊到按鈕、輸入框、下拉選單等互動控件時不觸發拖曳
          if (e.target.closest('button, input, select, textarea, a, .window-close-btn')) {
            return;
          }
          appWindow.startDragging();
        }
      });
    });
  } catch (err) {
    console.error('[Tauri Drag] 初始化拖曳事件失敗:', err);
  }
}
// 在 Tauri 獨立執行檔中，WebView2 需要一小段時間完成初始化後才能 fetch
// 若立即呼叫會觸發短暫的「無法連線」錯誤畫面，延遲 600ms 可完全避免
if (window.location.hostname === 'tauri.localhost' || window.location.protocol === 'tauri:') {
  setTimeout(checkAuthStatus, 600);
} else {
  checkAuthStatus();
}

// 註冊 Service Worker (僅在 Web 模式下啟用，小工具桌面端禁用 Service Worker 以防與 tauri:// 自訂協議衝突)
if (!isWidgetMode && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.log('SW registration failed: ', err);
    });
  });
}

// 通用：從伺服器安全下載檔案 (使用 fetch + Blob，確保 Cookie 跨域正確傳送，且不觸發 WebView2 導航)
async function downloadFromServer(url, filename) {
  try {
    showToast('正在下載...', 'info');
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) {
      showToast('下載失敗：' + res.status, 'error');
      return;
    }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    showToast('下載成功', 'success');
  } catch (err) {
    console.error('Download failed:', err);
    showToast('下載失敗', 'error');
  }
}

// 全域監聽小工具打開/下載按鈕
if (widgetBtnOpen) {
  widgetBtnOpen.addEventListener('click', (e) => {
    const href = widgetBtnOpen.getAttribute('href');
    if (!href || href.startsWith('#') || href === '') return;
    e.preventDefault();
    // 如果是下載按鈕（有 download 屬性），用 fetch+Blob 下載
    if (widgetBtnOpen.hasAttribute('download')) {
      const downloadName = widgetBtnOpen.getAttribute('download') || 'downloaded_file';
      downloadFromServer(href, downloadName);
    } else {
      // 否則在外部瀏覽器中開啟（如開啟網址）
      if (window.pywebview && window.pywebview.api) {
        window.pywebview.api.open_in_browser(href);
      } else {
        window.open(href, '_blank');
      }
    }
  });
}

// 實作自訂的 P2P 傳輸確認對話框 (防止 WebView2 系統 Confirm 對話框在超小視窗下被截斷)
function showP2pConfirmModal(sender, filename, size, onAccept, onReject) {
  if (isWidgetMode) {
    fitWindowToContent(); // 彈出確認視窗時，自動自適應
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = '2500'; // 確保超越一切圖層在最最上層

  overlay.innerHTML = `
    <div class="modal-content glass-card" style="width:260px; max-width:90%;">
      <div class="modal-header" style="padding:0.4rem 0.6rem;">
        <h3 style="font-size:0.85rem;color:#00f2fe;display:flex;align-items:center;gap:0.4rem;margin:0;">
          <i data-lucide="download-cloud" style="width:14px;height:14px;"></i> P2P 傳送請求
        </h3>
      </div>
      <div class="modal-body" style="padding:0.6rem; gap:0.4rem; font-size:0.75rem; text-align:center;">
        <p style="margin:0 0 0.4rem 0;color:var(--text-color);">來自「<strong>${escapeHtml(sender)}</strong>」的檔案傳送請求：</p>
        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05); padding:0.4rem; border-radius:6px; margin-bottom:0.5rem; text-align:left; word-break:break-all;">
          <div style="color:var(--text-color);">📄 <b>檔名:</b> ${escapeHtml(filename)}</div>
          <div style="margin-top:0.2rem;color:var(--text-muted);">💾 <b>大小:</b> ${formatBytes(size)}</div>
        </div>
        <div style="display:flex; gap:0.4rem; width:100%; margin-top:0.25rem;">
          <button class="btn btn-secondary" id="btn-p2p-reject" style="flex:1; padding:0.35rem; font-size:0.75rem;margin:0;">拒絕</button>
          <button class="btn btn-primary" id="btn-p2p-accept" style="flex:1; padding:0.35rem; font-size:0.75rem;margin:0;">接受</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  lucide.createIcons();

  const restoreWindowSize = () => {
    if (isWidgetMode) {
      fitWindowToContent(); // 關閉時自動還原高度
    }
  };

  overlay.querySelector('#btn-p2p-accept').addEventListener('click', () => {
    overlay.remove();
    restoreWindowSize();
    onAccept();
  });

  overlay.querySelector('#btn-p2p-reject').addEventListener('click', () => {
    overlay.remove();
    restoreWindowSize();
    onReject();
  });
}

// 實作自訂的高質感 Prompt 對話框 (消除 tauri.localhost 網頁提示框的違和感)
function showCustomPromptModal(title, text, defaultValue, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = '2600';

  const safeTitle = escapeHtml(title);
  const safeText = escapeHtml(text);
  const safeDefault = escapeHtml(defaultValue);

  overlay.innerHTML = `
    <div class="modal-content glass-card" style="width: 260px; max-width: 90%; padding: 1rem; border-radius: 12px; background: rgba(15,23,42,0.98); border: 1px solid rgba(0,242,254,0.3); box-shadow: 0 10px 30px rgba(0,0,0,0.7);">
      <div class="modal-header" style="margin-bottom: 0.8rem;">
        <h3 style="font-size: 0.85rem; color: #00f2fe; display: flex; align-items: center; gap: 0.4rem; margin: 0;">
          <i data-lucide="edit-3" style="width:14px;height:14px;"></i> ${safeTitle}
        </h3>
      </div>
      <div class="modal-body" style="padding: 0; display: flex; flex-direction: column; gap: 0.5rem;">
        <p style="margin: 0; font-size: 0.75rem; color: var(--text-color);">${safeText}</p>
        <input type="text" id="custom-prompt-input" value="${safeDefault}" style="width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; color: #fff; padding: 0.4rem 0.6rem; font-size: 0.75rem; outline: none; transition: border-color 0.2s;" onfocus="this.style.borderColor='#00f2fe'" onblur="this.style.borderColor='rgba(255,255,255,0.08)'">
        <div style="display: flex; gap: 0.4rem; margin-top: 0.2rem;">
          <button class="btn btn-secondary" id="btn-prompt-cancel" style="flex: 1; padding: 0.35rem; font-size: 0.75rem; margin: 0;">取消</button>
          <button class="btn btn-primary" id="btn-prompt-confirm" style="flex: 1; padding: 0.35rem; font-size: 0.75rem; margin: 0;">確定</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  lucide.createIcons();
  
  if (isWidgetMode) fitWindowToContent();

  const input = overlay.querySelector('#custom-prompt-input');
  input.focus();
  input.select();

  const closePrompt = () => {
    overlay.remove();
    if (isWidgetMode) fitWindowToContent();
  };

  overlay.querySelector('#btn-prompt-confirm').addEventListener('click', () => {
    const val = input.value;
    closePrompt();
    onConfirm(val);
  });

  overlay.querySelector('#btn-prompt-cancel').addEventListener('click', closePrompt);
  
  // 綁定 Enter 鍵提交
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = input.value;
      closePrompt();
      onConfirm(val);
    }
  });
}

// 實作自訂的高質感 Confirm 對話框
function showCustomConfirmModal(title, text, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = '2600';

  const safeTitle = escapeHtml(title);
  const safeText = escapeHtml(text);

  overlay.innerHTML = `
    <div class="modal-content glass-card" style="width: 260px; max-width: 90%; padding: 1rem; border-radius: 12px; background: rgba(15,23,42,0.98); border: 1px solid rgba(0,242,254,0.3); box-shadow: 0 10px 30px rgba(0,0,0,0.7);">
      <div class="modal-header" style="margin-bottom: 0.8rem;">
        <h3 style="font-size: 0.85rem; color: #ef4444; display: flex; align-items: center; gap: 0.4rem; margin: 0;">
          <i data-lucide="alert-triangle" style="width:14px;height:14px;"></i> ${safeTitle}
        </h3>
      </div>
      <div class="modal-body" style="padding: 0; display: flex; flex-direction: column; gap: 0.5rem;">
        <p style="margin: 0; font-size: 0.75rem; color: var(--text-color);">${safeText}</p>
        <div style="display: flex; gap: 0.4rem; margin-top: 0.2rem;">
          <button class="btn btn-secondary" id="btn-confirm-cancel" style="flex: 1; padding: 0.35rem; font-size: 0.75rem; margin: 0;">取消</button>
          <button class="btn btn-primary" id="btn-confirm-ok" style="flex: 1; padding: 0.35rem; font-size: 0.75rem; margin: 0; background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%) !important; border: none !important; color: #fff !important;">確定</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  lucide.createIcons();

  if (isWidgetMode) fitWindowToContent();

  const closeConfirm = () => {
    overlay.remove();
    if (isWidgetMode) fitWindowToContent();
  };

  overlay.querySelector('#btn-confirm-ok').addEventListener('click', () => {
    closeConfirm();
    onConfirm();
  });

  overlay.querySelector('#btn-confirm-cancel').addEventListener('click', closeConfirm);
}
