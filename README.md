# 🚀 Quick Portal

Quick Portal 是一個超輕量、即時的跨裝置剪貼簿與檔案傳送平台。支援大網頁與懸浮小工具雙模式，並提供局域網 WebRTC P2P 直連與公網伺服器暫存雙重傳輸管道。

---

## ✨ 核心特色

1. **使用者管理與認證**：極簡註冊與登入，文字與檔案暫存多用戶隔離。
2. **實體裝置歸戶**：同一台電腦的網頁與小工具連線自動依實體 IP 整合歸戶，提供裝置暱稱修改與刪除（解綁）管理。
3. **P2P 安全對傳**：當兩台不同裝置在同一個區域網路下時，支援 WebRTC 點對點秒速直連，且在接收端提供 AirDrop 風格的 **「接受/拒絕確認彈窗」** 安全防護。
4. **雲端中轉暫存**：若兩台裝置不在同一個區域網路，可一鍵切換至 Server 暫存模式傳送，檔案會儲存於伺服器並在 15 分鐘後自動過期清除。
5. **小工具模式**：精緻小巧的懸浮小工具視窗（`320x300`），支援貼上發送與檔案下載開啟。

---

## 💻 本地小工具啟動

請確保已安裝 `pywebview` 依賴：
```bash
pip install pywebview
```
執行啟動小工具：
```bash
python widget.py
```

---

## 🐳 Docker VDS/公網伺服器部署步驟

如果您想將 Quick Portal 架設在 VDS（虛擬專屬伺服器）或公網雲端主機上，請將專案中的以下**必備檔案**上傳至您的 VDS 目錄：
* `Dockerfile`
* `.dockerignore`
* `server.js`
* `package.json` 與 `package-lock.json`
* `public/` 資料夾（內含前端網頁資源）

在 VDS 上執行以下步驟進行部署：

### Step 1: 建置 Docker 映像檔
```bash
docker build -t quick-portal .
```

### Step 2: 建立宿主機持久化掛載路徑
為了保證您的註冊帳號與歷史文字紀錄在容器重啟或更新時**不會丟失**，請在 VDS 宿主機建立以下資料夾：
```bash
mkdir -p /opt/quick-portal/data /opt/quick-portal/uploads
```
*(若您想搬移目前本機測試的帳號，可將本機產生的 `users.json` 複製到 `/opt/quick-portal/data/` 底下)*

### Step 3: 啟動 Docker 容器
您可以使用一般的 `docker run` 指令啟動：
```bash
docker run -d \
  -p 5001:3000 \
  --name quick-portal \
  -v /opt/quick-portal/data:/app/data \
  -v /opt/quick-portal/uploads:/app/uploads \
  --restart unless-stopped \
  quick-portal
```
或者，**更推薦直接使用 Docker Compose 一鍵啟動**：
```bash
sudo docker compose up -d --build
```

現在，您就可以在瀏覽器輸入 `http://<VDS_公網_IP>:5001` 登入使用了！
