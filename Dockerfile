# 使用輕量級的 Node.js 20 Alpine 作為基礎映像檔
FROM node:20-alpine

# 設定工作目錄
WORKDIR /app

# 先複製 package 檔案以利用 Docker 緩存優化加速 build
COPY package*.json ./

# 安裝生產環境依賴
RUN npm ci --only=production

# 複製其餘專案檔案
COPY server.js ./
COPY public/ ./public/

# 宣告預設連接埠
ENV PORT=3000
EXPOSE 3000

# 建立並配置可掛載的持久化磁碟目錄 Volume
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data /app/uploads

# 宣告資料儲存目錄與暫存檔案目錄為 Volume
VOLUME ["/app/data", "/app/uploads"]

# 啟動 Node.js 伺服器
CMD ["node", "server.js"]
