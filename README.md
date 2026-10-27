# Discord 伺服器管理機器人

使用 TypeScript、discord.js 14 與 SQLite 製作，提供繁體中文管理指令、警告紀錄、禁言、踢出、封鎖、訊息清理、歡迎訊息與管理紀錄。使用 Slash Commands，不需要 Message Content Intent。

## 環境需求

- Node.js **24 或以上**、npm。
- Discord Application 與測試伺服器的管理權限。
- 可持續執行 Node.js 的主機，以及保存 SQLite 資料的持久磁碟。

此專案使用 Node.js 內建的 `node:sqlite`。Node.js 可能顯示 SQLite 實驗性功能提示，不影響本機資料庫的使用。啟動機器人需要自行設定 Discord Token；請勿把 Token 貼到聊天室或提交到 Git。

## 1. 建立 Discord Application

1. 前往 [Discord Developer Portal](https://discord.com/developers/applications)，建立 Application。
2. 在 **General Information** 複製 **Application ID**。
3. 在 **Bot** 頁面建立或重設 Token，安全保存。
4. 在 **Bot → Privileged Gateway Intents** 開啟 **Server Members Intent**，讓機器人收到新成員加入事件。若 Discord 要求審核，需先取得此 Intent 的使用資格。
5. 無須開啟 Message Content Intent 或 Presence Intent。
6. 若要取得伺服器 ID，在 Discord 的 **使用者設定 → 進階** 開啟開發者模式，再右鍵伺服器選擇「複製伺服器 ID」。

## 2. 安裝與設定

```sh
npm ci
cp .env.example .env
```

在本機編輯 `.env`：

| 變數 | 用途 |
| --- | --- |
| `DISCORD_TOKEN` | Bot Token，必填且保密。 |
| `DISCORD_CLIENT_ID` | Application ID，機器人啟動、註冊指令及產生邀請網址時必填。 |
| `DISCORD_GUILD_ID` | 測試伺服器 ID；填入時僅註冊到該伺服器，留空則註冊全域指令。 |
| `DATABASE_PATH` | SQLite 路徑，預設為 `./data/bot.sqlite`。 |

相對資料庫路徑以啟動指令的目前目錄為基準。部署時請使用固定工作目錄或資料庫絕對路徑。

## 3. 邀請機器人並註冊指令

```sh
npm run invite
```

開啟輸出的 OAuth2 邀請網址，選擇目標伺服器。邀請範圍包含 `bot` 與 `applications.commands`。機器人需要下列功能權限，無須授予 Administrator：

| 權限 | 用途 |
| --- | --- |
| View Channels、Send Messages、Embed Links | 歡迎訊息與管理紀錄。 |
| Read Message History、Manage Messages | 讀取及批次清理訊息。 |
| Moderate Members | 設定與解除禁言。 |
| Kick Members | 踢出成員。 |
| Ban Members | 封鎖及解除封鎖。 |

在 **伺服器設定 → 身分組** 中，將機器人的身分組放在它需要管理的成員身分組上方。頻道覆寫權限也必須允許機器人檢視頻道及執行對應操作。

```sh
npm run register
```

建議先填入 `DISCORD_GUILD_ID` 測試。伺服器指令通常很快生效；全域指令可能需要等待 Discord 更新。註冊會替換該 Application 在所選範圍的指令清單，請為此機器人使用獨立的 Application。改用其他註冊範圍不會自動移除先前範圍的指令。

## 4. 啟動

開發模式：

```sh
npm run dev
```

正式執行：

```sh
npm run build
npm start
```

同一份 SQLite 資料庫請只啟動一個機器人程序。正式主機可使用 systemd 或其他程序管理工具維持執行，並將 `.env` 或主機環境變數安全提供給程序。請勿將 `.env` 放在可公開下載的網站目錄中。

## 指令

`/help` 與 `/ping` 提供一般說明及連線狀態。管理指令會檢查操作者權限；即使 Discord 顯示了指令，也不能繞過執行時的權限與角色階級檢查。

| 指令 | 功能 | 操作者權限 |
| --- | --- | --- |
| `/help` | 查看使用說明。 | 一般成員 |
| `/ping` | 查看機器人延遲。 | 一般成員 |
| `/warn user reason` | 新增成員警告，保存管理者及原因。 | Moderate Members |
| `/warnings user` | 查看該成員最近 10 筆警告及總數。 | Moderate Members |
| `/timeout user minutes reason` | 禁言 1 至 40,320 分鐘（28 天）。 | Moderate Members |
| `/untimeout user reason` | 解除禁言。 | Moderate Members |
| `/kick user reason` | 確認後踢出成員。 | Kick Members |
| `/ban user reason [delete_days]` | 確認後封鎖成員；可選擇刪除最近 0 至 7 天訊息。 | Ban Members |
| `/unban user_id reason` | 依 Discord 使用者 ID 解除封鎖。 | Ban Members |
| `/clear amount` | 確認後清理目前頻道的 1 至 100 則訊息。 | Manage Messages |
| `/config view` | 查看此伺服器的設定。 | Manage Server |
| `/config logs [channel]` | 設定管理紀錄頻道；省略頻道則停用。 | Manage Server |
| `/config welcome [channel]` | 設定歡迎頻道；省略頻道則停用。 | Manage Server |
| `/config welcome-message message` | 設定歡迎訊息範本，最多 1,000 字元。 | Manage Server |

踢出、封鎖與清理訊息會先顯示僅操作者可見的確認按鈕，30 秒後失效。執行時仍會重新檢查權限。無法管理伺服器擁有者、自己或機器人本身，也不能對同級或較高角色成員執行受限制的操作；伺服器擁有者執行的 Discord 管理操作仍受機器人角色階級限制。本機警告紀錄不需要機器人修改目標角色。Discord 不允許對管理員或機器人成員設定禁言。

清理功能支援伺服器的文字及公告頻道。Discord 批次刪除限制只允許清理未滿 14 天的訊息，因此送出數量可能少於要求數量。確認期間新到達的訊息不會加入刪除範圍。清理結果會回報送出數量；Discord 不回傳批次操作的實際刪除數量，其他管理員同時刪除訊息也可能影響結果。刪除、踢出與封鎖會立即影響伺服器，請先在測試頻道驗證。

### 歡迎訊息

```text
/config welcome channel:#歡迎
/config welcome-message message:歡迎 {user} 加入 {server}！你是第 {count} 位成員。
```

| 變數 | 替換內容 |
| --- | --- |
| `{user}` | 新加入成員。 |
| `{server}` | 伺服器名稱。 |
| `{count}` | 目前伺服器成員數。 |

歡迎訊息與管理紀錄只能設定到同一伺服器的文字或公告頻道，且機器人需要對應的檢視與發送權限。歡迎訊息預設不啟用，需先設定頻道。

### 資料與紀錄

設定、警告與管理操作紀錄保存在 SQLite，重新啟動後仍會保留，各伺服器資料分開查詢。管理紀錄頻道是額外通知；頻道被刪除或失去發送權限時，通知失敗不代表已成功的管理操作會撤回。也可透過 Discord 原生稽核紀錄查看 Discord 支援的管理操作。

請將資料庫放在持久磁碟並定期備份。複製資料庫前先正常停止機器人，再備份完整資料目錄；執行中的 SQLite 可能還有 `-wal` 與 `-shm` 檔案，僅複製主檔可能漏失資料。資料庫含使用者 ID、警告原因及管理紀錄，請限制檔案存取並按社群需求管理保存期限。

## 檢查與測試

```sh
npm run check
npm test
npm run build
```

自動測試不需要 Discord Token，也不會連線操作真實伺服器。正式使用前，請在測試伺服器驗證指令註冊、機器人角色位置、頻道權限、歡迎事件及管理操作。

## 常見問題

- **指令沒有出現：** 確認 Application ID 與 Bot Token 屬於同一個 Application、邀請包含 `applications.commands`，並重新執行 `npm run register`。檢查 `DISCORD_GUILD_ID` 是否是目前伺服器；全域指令可能仍在更新。
- **Missing Permissions 或無法管理某位成員：** 檢查機器人及操作者的功能權限、頻道覆寫權限，以及雙方的最高角色位置。
- **歡迎訊息沒有出現：** 確認已設定歡迎頻道、開啟 Server Members Intent，且機器人能在該頻道發送訊息。
- **Disallowed Intents：** 在 Developer Portal 開啟 Server Members Intent，再重新啟動。需要審核的 Application 必須先取得 Discord 核准。
- **重新部署後資料消失：** 確認 `DATABASE_PATH` 指向持久磁碟，而非部署時會清空的暫存目錄。
- **Token 外洩：** 立即在 Developer Portal 重設 Token、更新主機上的設定並重新啟動，從版本紀錄及公開內容移除舊 Token。
