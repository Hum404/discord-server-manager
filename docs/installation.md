# 安裝與啟動

[專案首頁](../README.md) · [安裝](installation.md) · [使用指南](commands.md) · [部署更新](deployment.md) · [常見問題](troubleshooting.md)

首次部署請從這裡開始。已在運行的 Bot 請依[部署更新](deployment.md)操作，保留原有 `.env` 與資料庫。

## 環境需求

- Node.js **24 或以上**、npm。
- Discord Application 與測試伺服器的管理權限。
- 可持續執行 Node.js 的主機，以及保存 SQLite 資料的持久磁碟。

此專案使用 Node.js 內建的 `node:sqlite`。Node.js 可能顯示 SQLite 實驗性功能提示，不影響本機資料庫的使用。**只需填入 Discord Bot Token**，程式便會自動取得 Application ID，並在啟動時註冊指令。Token 由 Discord Developer Portal 建立，無法透過本機終端機指令產生；請勿把 Token 貼到聊天室或提交到 Git。

## 建立 Discord Application

1. 前往 [Discord Developer Portal](https://discord.com/developers/applications)，建立 Application。
2. 在 **Bot** 頁面建立或重設 Token，安全保存；不需要複製 Application ID。
3. 在 **Bot → Privileged Gateway Intents** 開啟 **Server Members Intent**，讓機器人收到新成員加入事件。若 Discord 要求審核，需先取得此 Intent 的使用資格。
4. 無須開啟 Message Content Intent 或 Presence Intent。
5. 選用測試伺服器時，可在 Discord 的 **使用者設定 → 進階** 開啟開發者模式，再右鍵伺服器選擇「複製伺服器 ID」。一般啟動不需要填伺服器 ID。

## 安裝與設定

取得程式並進入專案目錄：

```sh
git clone https://github.com/Hum404/discord-server-manager.git
```

```sh
cd discord-server-manager
```

安裝相依套件並建立設定檔：

```sh
npm ci
```

```sh
cp .env.example .env
```

在本機編輯 `.env`，只需填入 `DISCORD_TOKEN`，其餘項目可保留預設值：

| 變數 | 用途 |
| --- | --- |
| `DISCORD_TOKEN` | Bot Token，必填且保密。 |
| `DISCORD_GUILD_ID` | 測試伺服器 ID；填入時伺服器功能註冊到指定伺服器，另提供私訊申訴入口；留空則註冊全域指令。 |
| `DATABASE_PATH` | SQLite 路徑，預設為 `./data/bot.sqlite`。 |

Application ID 一律由 Token 自動取得。舊版 `.env` 若有 `DISCORD_CLIENT_ID`，可直接保留，程式會忽略此變數，不會檢查或使用其值。

相對資料庫路徑以啟動指令的目前目錄為基準。部署時請使用固定工作目錄或資料庫絕對路徑。

## 邀請機器人

```sh
npm run invite
```

此指令會使用 Token 向 Discord 取得 Application ID，自動產生 OAuth2 邀請網址。開啟網址，選擇目標伺服器並授權。邀請範圍包含 `bot` 與 `applications.commands`。機器人需要下列功能權限，無須授予 Administrator：

| 權限 | 用途 |
| --- | --- |
| View Channels、Send Messages、Embed Links | 歡迎訊息、管理紀錄及處罰公告。 |
| Read Message History、Manage Messages、Pin Messages | 讀取、清理、置頂及取消置頂訊息。 |
| Moderate Members | 設定與解除禁言。 |
| Kick Members | 踢出成員。 |
| Ban Members | 封鎖及解除封鎖。 |
| Manage Channels、Manage Roles | 建立文字子區、設定與還原頻道內的成員權限。 |
| Mention Everyone | 讓子區建立者透過 Bot 發送身分組及 everyone／here 通知。 |
| Manage Threads、Send Messages in Threads、Create Public Threads、Create Private Threads | 建立及管理討論串與論壇帖子、原生鎖定與封存／解鎖及移除討論串成員。 |
| Add Reactions | 子區互動所需的反應權限。 |

在 **伺服器設定 → 身分組** 中，將機器人的身分組放在它需要管理的成員身分組上方。頻道覆寫權限也必須允許機器人檢視頻道及執行對應操作。

若從尚未具備子區及置頂權限的舊版升級，請重新執行 `npm run invite`，開啟新網址並對同一伺服器完成授權。已具備這些權限的部署，新增訊息 APP 選單時不需要重新邀請機器人。機器人仍無須 Administrator。

## 啟動

開發模式：

```sh
npm run dev
```

正式執行：

```sh
npm run build
```

```sh
npm start
```

啟動時會先向 Discord 取得 Application 資料、自動註冊 Slash Commands 與訊息 APP 選單，再連線 Gateway。無須另外執行指令註冊，也無須提供 Application ID 或伺服器 ID。

預設註冊全域指令，Discord 更新可能需要等待。開發測試時可選填 `DISCORD_GUILD_ID`，讓伺服器指令僅註冊到該伺服器，通常更快生效；此模式也會額外提供僅限 Bot 私訊的申訴入口。若要在未啟動機器人時單獨註冊，也可執行 `npm run register`。註冊會替換此 Application 在所選範圍的指令清單，請為此機器人使用獨立的 Application。改用其他註冊範圍不會自動移除先前範圍的指令。

同一份 SQLite 資料庫請只啟動一個機器人程序。正式主機可使用 systemd 或其他程序管理工具維持執行，並將 `.env` 或主機環境變數安全提供給程序。請勿將 `.env` 放在可公開下載的網站目錄中。

### 重用現有 Bot 時清理舊指令

若沿用既有 Bot Token，而 Discord 仍顯示舊指令，可執行：

```sh
npm run commands:sync
```

程式會透過 Token 取得 Application ID，並列出機器人所在的伺服器名稱供輸入編號選擇；只有一個伺服器時會自動選取。若已設定 `DISCORD_GUILD_ID`，伺服器專屬指令只會更新該伺服器，同時會移除這個 Bot 不支援的全域指令；全域指令的移除會影響這個 Bot 所在的所有伺服器。其他 Bot 的指令，以及其他伺服器的專屬指令都不會變更。

修改前會先保存指令 JSON 備份，預設位置為 `data/command-backups/`；自訂資料庫路徑時，備份存於資料庫目錄下的 `command-backups/`。處理範圍依設定而定：

- **全域模式（未設定 `DISCORD_GUILD_ID`）：** 以本專案目前的指令覆寫全域清單，再移除所選伺服器的舊指令覆寫，讓它使用新的全域指令。其他伺服器自己的指令註冊不變。
- **伺服器模式（已設定 `DISCORD_GUILD_ID`）：** 以目前指令覆寫該伺服器的清單；全域清單僅刪除本專案不支援的指令名稱或類型，不會新增全域指令。刪除全域項目會影響同一 Application 的所有伺服器。

完成後程式會透過 Discord API 重新讀取並驗證結果。若畫面仍顯示舊指令，重新啟動 Discord 讓快取更新；若舊指令再次出現，請停止仍在註冊舊清單的舊版部署。

## 檢查與測試

```sh
npm run check
```

```sh
npm test
```

```sh
npm run build
```

自動測試不需要 Discord Token，也不會連線操作真實伺服器。正式使用前，請在測試伺服器驗證指令註冊、機器人角色位置、頻道權限、歡迎事件及管理操作。

## 隱私與服務條款

- [隱私政策](../PRIVACY_POLICY.md)：資料用途、通知可見範圍、保存方式及資料權利請求。
- [服務條款](../TERMS_OF_SERVICE.md)：使用資格、管理責任、申訴、功能限制及服務規則。

兩份文件均為公開頁面，可將其 GitHub 頁面網址填入 Discord Developer Portal 的 Privacy Policy URL 與 Terms of Service URL。自行架設的營運者應提供實際聯絡方式、資料存放與保存安排，並在有不同處理方式時發布自己的政策。
