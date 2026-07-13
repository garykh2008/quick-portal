import webview
import sys
import webbrowser
import os
import urllib.request

# 宣告全域 window 變數，避免將其作為屬性存入 Api 實例中導致 pywebview 遞迴序列化崩潰
window = None

# Python JS API 橋接器，解決 WebView2 下載檔案無反應的底層限制，並支援默默下載
class Api:
    def __init__(self):
        self.server_url = ""

    def open_in_browser(self, url):
        # 如果是相對路徑，補全為伺服器的絕對 URL
        full_url = url
        if url.startswith('/'):
            full_url = self.server_url + url
        print(f"[Python API] 呼叫外部瀏覽器打開連結: {full_url}")
        webbrowser.open(full_url)

    def get_downloads_path(self):
        # 取得 Windows 系統預設的「下載」資料夾 (Downloads)
        home = os.path.expanduser('~')
        downloads = os.path.join(home, 'Downloads')
        if os.path.exists(downloads):
            return downloads
        return os.getcwd() # 備用方案：目前執行目錄

    def download_file_via_python(self, relative_url, original_name):
        global window  # 安全地從全域作用域讀取 window 對象，繞過 pywebview 遞迴遍歷
        full_url = self.server_url + relative_url
        downloads_dir = self.get_downloads_path()
        target_path = os.path.join(downloads_dir, original_name)

        # 防止檔名衝突，如果已存在，自動更名為 filename(1).ext, filename(2).ext
        base, extension = os.path.splitext(original_name)
        counter = 1
        while os.path.exists(target_path):
            target_path = os.path.join(downloads_dir, f"{base}({counter}){extension}")
            counter += 1

        print(f"[Python API] 默默下載中: {full_url} -> {target_path}")

        try:
            # 呼叫 urllib 默默下載並保存
            # 這會正常觸發後端的 node api 下載即刪除邏輯！
            urllib.request.urlretrieve(full_url, target_path)
            final_filename = os.path.basename(target_path)
            print(f"[Python API] 下載成功: {target_path}")
            
            # 使用 evaluate_js 呼叫前端 JS 的 showToast 發送高質感提示
            if window:
                safe_name = final_filename.replace("'", "\\'")
                window.evaluate_js(f"showToast('已儲存至下載資料夾：{safe_name}', 'success')")
        except Exception as e:
            print(f"[Python API] 下載失敗: {e}")
            if window:
                safe_error = str(e).replace("'", "\\'")
                window.evaluate_js(f"showToast('下載失敗：{safe_error}', 'error')")

# 預設連線到 localhost:3000 
server_url = "http://localhost:3000/?mode=widget"

# 允許使用者在命令列帶入特定的伺服器 IP，例如: python widget.py 192.168.1.105:3000
if len(sys.argv) > 1:
    target = sys.argv[1]
    if not target.startswith("http://") and not target.startswith("https://"):
        server_url = f"http://{target}/?mode=widget"
    else:
        separator = "&" if "?" in target else "?"
        server_url = f"{target}{separator}mode=widget"

# 提取伺服器基礎 URL
base_server_url = server_url.split('/?')[0]

print("==================================================")
print("🚀 Quick Portal 桌面懸浮小工具正在啟動...")
print("==================================================")
print(f"🔗 連線網址: {server_url}")
print("📌 已啟用「永遠置頂 (Always-on-Top)」模式")
print("📥 支援直接將檔案拖入此視窗進行傳送")
print("==================================================")

# 初始化 JS API
api_instance = Api()
api_instance.server_url = base_server_url

# 建立桌面置頂懸浮視窗，並繫結全域 window 變數
window = webview.create_window(
    title="Quick Portal Widget",
    url=server_url,
    width=320,
    height=300,
    on_top=True,
    resizable=False,
    js_api=api_instance
)

webview.start()
