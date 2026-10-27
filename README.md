# Discord 伺服器管理機器人

使用 TypeScript、discord.js 14 與 SQLite 製作，提供繁體中文管理指令、逐項管理授權、處罰申訴工單、獨立文字子區、警告、禁言、踢出、封鎖、訊息清理及歡迎訊息。使用 Slash Commands，不需要 Message Content Intent。

## 環境需求

- Node.js **24 或以上**、npm。
- Discord Application 與測試伺服器的管理權限。
- 可持續執行 Node.js 的主機，以及保存 SQLite 資料的持久磁碟。

此專案使用 Node.js 內建的 `node:sqlite`。Node.js 可能顯示 SQLite 實驗性功能提示，不影響本機資料庫的使用。**只需填入 Discord Bot Token**，程式便會自動取得 Application ID，並在啟動時註冊指令。Token 由 Discord Developer Portal 建立，無法透過本機終端機指令產生；請勿把 Token 貼到聊天室或提交到 Git。

## 1. 建立 Discord Application

1. 前往 [Discord Developer Portal](https://discord.com/developers/applications)，建立 Application。
2. 在 **Bot** 頁面建立或重設 Token，安全保存；不需要複製 Application ID。
3. 在 **Bot → Privileged Gateway Intents** 開啟 **Server Members Intent**，讓機器人收到新成員加入事件。若 Discord 要求審核，需先取得此 Intent 的使用資格。
4. 無須開啟 Message Content Intent 或 Presence Intent。
5. 選用測試伺服器時，可在 Discord 的 **使用者設定 → 進階** 開啟開發者模式，再右鍵伺服器選擇「複製伺服器 ID」。一般啟動不需要填伺服器 ID。

## 2. 安裝與設定

```sh
npm ci
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

## 3. 邀請機器人

```sh
npm run invite
```

此指令會使用 Token 向 Discord 取得 Application ID，自動產生 OAuth2 邀請網址。開啟網址，選擇目標伺服器並授權。邀請範圍包含 `bot` 與 `applications.commands`。機器人需要下列功能權限，無須授予 Administrator：

| 權限 | 用途 |
| --- | --- |
| View Channels、Send Messages、Embed Links | 歡迎訊息與管理紀錄。 |
| Read Message History、Manage Messages | 讀取及批次清理訊息。 |
| Moderate Members | 設定與解除禁言。 |
| Kick Members | 踢出成員。 |
| Ban Members | 封鎖及解除封鎖。 |
| Manage Channels、Manage Roles | 建立文字子區、設定與還原頻道內的成員權限。 |
| Mention Everyone | 讓子區建立者透過 Bot 發送身分組及 everyone／here 通知。 |

在 **伺服器設定 → 身分組** 中，將機器人的身分組放在它需要管理的成員身分組上方。頻道覆寫權限也必須允許機器人檢視頻道及執行對應操作。

舊版機器人升級後，請重新執行 `npm run invite`，開啟新網址並對同一伺服器完成授權，以補上子區功能所需的權限。機器人仍無須 Administrator。

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

啟動時會先向 Discord 取得 Application 資料、自動註冊 Slash Commands，再連線 Gateway。無須另外執行指令註冊，也無須提供 Application ID 或伺服器 ID。

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

## 指令

`/help` 與 `/ping` 提供一般說明及連線狀態。管理指令允許受授權用戶在 Discord 選單中看到，因此一般成員也可能看得到；執行時仍會檢查原生權限或 Bot 授權、角色階級及機器人權限。

| 指令 | 功能 | 操作者權限 |
| --- | --- | --- |
| `/help` | 查看使用說明。 | 一般成員 |
| `/ping` | 查看機器人延遲。 | 一般成員 |
| `/warn user reason` | 新增成員警告，保存管理者及原因。 | Moderate Members 或 `warn` 授權 |
| `/warnings user` | 查看該成員最近 10 筆警告及總數。 | Moderate Members 或 `warn` 授權 |
| `/timeout user minutes reason` | 禁言 1 至 40,320 分鐘（28 天）。 | Moderate Members 或 `timeout` 授權 |
| `/untimeout user reason` | 解除禁言。 | Moderate Members 或 `timeout` 授權 |
| `/kick user reason` | 確認後踢出成員。 | Kick Members 或 `kick` 授權 |
| `/ban user reason [delete_days]` | 確認後封鎖成員；可選擇刪除最近 0 至 7 天訊息。 | Ban Members 或 `ban` 授權 |
| `/unban user_id reason` | 依 Discord 使用者 ID 解除封鎖。 | Ban Members 或 `ban` 授權 |
| `/clear amount` | 確認後清理目前頻道的 1 至 100 則訊息。 | Manage Messages 或 `clear` 授權；仍需查看及讀取頻道歷史 |
| `/config view` | 查看此伺服器的設定。 | Manage Server |
| `/config logs [channel]` | 設定管理紀錄頻道；省略頻道則停用。 | Manage Server |
| `/config welcome [channel]` | 設定歡迎頻道；省略頻道則停用。 | Manage Server |
| `/config welcome-message message` | 設定歡迎訊息範本，最多 1,000 字元。 | Manage Server |
| `/config appeals [channel]` | 設定私人申訴通知頻道；省略則停用頻道通知。 | Manage Server |
| `/config subareas [category]` | 開放在指定分類建立子區；省略則停用新建。 | Manage Server |
| `/access grant user scope` | 授予指定或全部 Bot 管理功能。 | 伺服器擁有者或原生 Administrator |
| `/access revoke user [scope]` | 撤回指定授權；省略則撤回全部。 | 伺服器擁有者或原生 Administrator |
| `/access list [user]` | 查看本伺服器的管理授權。 | 伺服器擁有者或原生 Administrator |
| `/appeal submit [case]` | 開啟表單，申訴自己的案件；省略使用最近處罰。 | 案件當事人，可於伺服器或 Bot 私訊使用 |
| `/appeal status [id]` | 查詢自己的申訴工單。 | 工單申訴人 |
| `/appeal queue [id] [status]` | 查看工單清單或指定工單完整內容。 | 原生 Manage Server 或伺服器擁有者 |
| `/appeal review id result reason` | 通過或駁回申訴並記錄處理說明。 | 原生 Manage Server 或伺服器擁有者 |
| `/subarea create name` | 在已開放的分類建立自己的獨立文字頻道。 | 可查看該分類的成員，每人最多 3 個 |
| `/subarea assign channel user` | 登記既有文字頻道或轉移子區建立者。 | 伺服器擁有者或原生 Administrator |
| `/subarea list` | 查看自己建立的子區。 | 一般成員 |
| `/subarea mute user reason` | 禁止成員在目前子區發言、開討論串及新增反應。 | 該子區建立者或原生 Administrator |
| `/subarea unmute user [reason]` | 解除目前子區的禁言。 | 該子區建立者或原生 Administrator |
| `/subarea kick user reason` | 確認後禁止成員查看及進入目前子區。 | 該子區建立者或原生 Administrator |
| `/subarea unkick user [reason]` | 恢復目前子區的存取。 | 該子區建立者或原生 Administrator |
| `/subarea tag user [message]` | 透過 Bot 標註指定用戶。 | 僅目前子區建立者 |
| `/subarea role-tag role [message]` | 透過 Bot 標註指定身分組。 | 僅目前子區建立者 |
| `/subarea announce audience message` | 在子區通知 `everyone` 或 `here`。 | 僅目前子區建立者 |

踢出、封鎖與清理訊息會先顯示僅操作者可見的確認按鈕，30 秒後失效。執行時仍會重新檢查權限。無法管理伺服器擁有者、自己或機器人本身，也不能對同級或較高角色成員執行受限制的操作；伺服器擁有者執行的 Discord 管理操作仍受機器人角色階級限制。本機警告紀錄不需要機器人修改目標角色。Discord 不允許對管理員或機器人成員設定禁言。

清理功能支援伺服器的文字及公告頻道。Discord 批次刪除限制只允許清理未滿 14 天的訊息，因此送出數量可能少於要求數量。確認期間新到達的訊息不會加入刪除範圍。清理結果會回報送出數量；Discord 不回傳批次操作的實際刪除數量，其他管理員同時刪除訊息也可能影響結果。刪除、踢出與封鎖會立即影響伺服器，請先在測試頻道驗證。

### 管理功能授權

原生 Administrator 或伺服器擁有者可以把 Bot 的管理功能逐項授予用戶，無須授予對方 Discord 的全域管理身分組。授權範圍為 `warn`、`timeout`、`kick`、`ban`、`clear`，或 `all`；`warn` 包含警告查詢，`timeout` 包含解除禁言，`ban` 包含解除封鎖。

```text
/access grant user:@小明 scope:timeout
/access grant user:@小明 scope:warn
/access list user:@小明
/access revoke user:@小明 scope:timeout
```

每次執行會確認授權仍存在、原授權者仍在伺服器且仍有 Administrator 權限。受授權者可管理的角色階級以授權者目前的角色為上限，並受機器人角色階級限制；不能透過授權處罰伺服器擁有者、管理員或具備 Manage Server 的成員。確認按鈕及處罰通知私訊之後也會重新檢查，授權被撤回時會停止後續操作。

Bot 授權不包含再次授權別人、修改伺服器設定或審核申訴。撤回 Bot 授權不會移除用戶原本的 Discord 身分組權限；本來已有對應原生權限的用戶仍可使用該功能。

### 處罰申訴工單

先建立一個只有審核人員可見的文字頻道，再設定通知位置：

```text
/config appeals channel:#申訴審核
```

程式會檢查此頻道的 `@everyone`、非管理身分組及個別非管理成員都沒有查看權限，並確認 Bot 能查看、發送訊息及嵌入連結。審核人員需有原生 Manage Server 或 Administrator 權限；若其他普通身分組仍可查看，Bot 會拒絕發送工單內容。尚未設定通知頻道或通知失敗時，工單仍保存在 SQLite，管理員可使用 `/appeal queue` 查看。

警告、禁言、踢出、封鎖及子區處罰前，Bot 會先私訊申訴入口。操作完成且案件已保存後，當事人可按私訊中的「提交申訴」，或執行：

```text
/appeal submit
/appeal status
```

表單可選擇自己的案件編號並填寫申訴說明；每個案件僅能提交一張工單，不能查閱或申訴其他用戶的案件。若對方關閉私訊，通知可能失敗，執行處罰的管理者會收到提示；被踢出或封鎖後，請使用先前送達的私訊按鈕。無法送達私訊時，需由管理員另行提供可聯絡的申訴管道。

原生具有 Manage Server 的管理員可在伺服器查看工單、按工單訊息上的按鈕，或使用指令審核：

```text
/appeal queue
/appeal queue id:1
/appeal review id:1 result:accepted reason:已確認補充證據，通過申訴。
```

審核結果會保存並嘗試私訊通知當事人。**通過申訴不會自動撤銷原處罰**；管理員需另行解除禁言、封鎖或子區限制，已踢出成員需重新加入。單靠 Bot 管理授權不能查看或審核工單。

### 獨立文字子區

子區是獨立文字頻道，由 Bot 保存建立者身分。先建立分類並開放用戶建立：

```text
/config subareas category:社群子區
/subarea create name:小明的討論區
```

只有可查看該分類的用戶可以建立，每人每個伺服器最多保留 3 個。新子區繼承分類的可見範圍，建立者透過 Bot 管理子區，不會因此取得伺服器的 Manage Channels 或 Manage Roles。管理員可登記既有頻道或更換建立者：

```text
/subarea assign channel:#小明的討論區 user:@小明
```

在子區內執行下列指令，只會修改目前子區的成員權限：

```text
/subarea mute user:@用戶 reason:持續洗版
/subarea kick user:@用戶 reason:違反本子區規則
/subarea unmute user:@用戶
/subarea unkick user:@用戶
```

子區禁言會限制發言、討論串發言與建立、以及新增反應；子區踢出會禁止查看及進入，不會將成員踢出整個伺服器。兩種限制可同時存在，解除其中一種會保留另一種；解除時還原 Bot 管理的權限項目，保留其他權限設定。原生 Administrator 依 Discord 規則可繞過頻道限制，Bot 不允許子區建立者限制管理員、伺服器管理者、自己或機器人。

Bot 的標註指令僅限目前建立者，管理員也不能藉此替其他人的子區發送標註；每個子區每 30 秒可使用一次：

```text
/subarea tag user:@用戶 message:請查看本區規則
/subarea role-tag role:@活動成員 message:活動即將開始
/subarea announce audience:everyone message:本區公告
```

新建子區會把 Mention Everyone 權限保留給建立者及 Bot。這不會禁止 Discord 本身允許的個別用戶提及，或提及已設定為可標註的身分組；原生 Administrator 亦可繞過頻道覆寫。Bot 提供的三種標註指令仍嚴格檢查建立者身分。

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

設定、警告、管理授權、申訴工單、子區建立者與限制狀態都保存在 SQLite，重新啟動後仍會保留，各伺服器資料分開查詢。首次啟動新版時會自動新增資料表及設定欄位，保留舊的警告、案件與設定。子區權限同時保存在 Discord 頻道覆寫中，不依賴 Bot 持續在線才生效。

管理紀錄頻道是額外通知；頻道被刪除或失去發送權限時，通知失敗不代表已成功的管理操作會撤回。也可透過 Discord 原生稽核紀錄查看 Discord 支援的管理操作。

請將資料庫放在持久磁碟並定期備份。複製資料庫前先正常停止機器人，再備份完整資料目錄；執行中的 SQLite 可能還有 `-wal` 與 `-shm` 檔案，僅複製主檔可能漏失資料。資料庫含使用者 ID、警告原因及管理紀錄，請限制檔案存取並按社群需求管理保存期限。

## 阿里雲現有部署更新

以下沿用 `/opt/discord-manager`、`discordbot` 帳號及 `discord-manager` systemd 服務。每次只執行一個命令區塊；保留原本 `.env`，不需要重新填 Token 或 ID。更新前請先正常停止服務並備份資料目錄。

停止服務：

```sh
sudo systemctl stop discord-manager
```

若資料庫使用先前部署路徑 `/var/lib/discordbot/bot.sqlite`，備份此目錄；自訂路徑請調整來源：

```sh
sudo tar -C /var/lib -czf /root/discordbot-backup-$(date +%Y%m%d-%H%M%S).tar.gz discordbot
```

取得更新：

```sh
sudo -u discordbot -H git -C /opt/discord-manager pull --ff-only
```

編譯新版：

```sh
sudo -u discordbot -H npm --prefix /opt/discord-manager run build
```

啟動並自動註冊新版指令：

```sh
sudo systemctl restart discord-manager
```

產生新的邀請網址，開啟網址對原伺服器重新授權，補上子區所需的 Manage Channels、Manage Roles、Mention Everyone：

```sh
sudo -u discordbot -H npm --prefix /opt/discord-manager run invite
```

檢查啟動結果：

```sh
sudo journalctl -u discord-manager -n 50 --no-pager
```

最後在 Discord 設定私人申訴頻道與子區分類，再依需要授權用戶：

```text
/config appeals channel:#申訴審核
```

```text
/config subareas category:社群子區
```

```text
/access grant user:@小明 scope:timeout
```

## 檢查與測試

```sh
npm run check
npm test
npm run build
```

自動測試不需要 Discord Token，也不會連線操作真實伺服器。正式使用前，請在測試伺服器驗證指令註冊、機器人角色位置、頻道權限、歡迎事件及管理操作。

## 常見問題

- **指令沒有出現：** 確認機器人已成功啟動並完成自動註冊，且邀請包含 `applications.commands`。若有設定 `DISCORD_GUILD_ID`，確認是目前伺服器；全域指令可能仍在更新。也可執行 `npm run register` 手動重試。
- **Missing Permissions 或無法管理某位成員：** 檢查機器人及操作者的功能權限、頻道覆寫權限，以及雙方的最高角色位置。
- **授權後看不到管理指令：** 查看伺服器設定中的應用程式整合與指令使用權限。Bot 授權不會移除 Discord 另外設定的指令禁止規則。
- **申訴沒有出現在頻道：** 用 `/appeal queue` 確認工單是否已保存，並檢查 `/config appeals`、頻道私人設定及 Bot 的發送／嵌入連結權限。
- **子區無法建立或限制成員：** 重新使用新版邀請網址授權 Manage Channels、Manage Roles、Mention Everyone，確認已設定 `/config subareas`，並檢查分類覆寫與 Bot 角色位置。
- **歡迎訊息沒有出現：** 確認已設定歡迎頻道、開啟 Server Members Intent，且機器人能在該頻道發送訊息。
- **Disallowed Intents：** 在 Developer Portal 開啟 Server Members Intent，再重新啟動。需要審核的 Application 必須先取得 Discord 核准。
- **重新部署後資料消失：** 確認 `DATABASE_PATH` 指向持久磁碟，而非部署時會清空的暫存目錄。
- **Token 外洩：** 立即在 Developer Portal 重設 Token、更新主機上的設定並重新啟動，從版本紀錄及公開內容移除舊 Token。
