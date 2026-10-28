# Discord 伺服器管理機器人

使用 TypeScript、discord.js 14 與 SQLite 製作，提供繁體中文管理指令、逐項管理授權、處罰申訴工單、文字頻道／討論串／論壇子區、子區協管與置頂管理、警告、禁言、踢出、封鎖、訊息清理及歡迎訊息。支援 Slash Commands 與訊息「APP」選單，不需要 Message Content Intent。

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

## 3. 邀請機器人

```sh
npm run invite
```

此指令會使用 Token 向 Discord 取得 Application ID，自動產生 OAuth2 邀請網址。開啟網址，選擇目標伺服器並授權。邀請範圍包含 `bot` 與 `applications.commands`。機器人需要下列功能權限，無須授予 Administrator：

| 權限 | 用途 |
| --- | --- |
| View Channels、Send Messages、Embed Links | 歡迎訊息與管理紀錄。 |
| Read Message History、Manage Messages、Pin Messages | 讀取、清理、置頂及取消置頂訊息。 |
| Moderate Members | 設定與解除禁言。 |
| Kick Members | 踢出成員。 |
| Ban Members | 封鎖及解除封鎖。 |
| Manage Channels、Manage Roles | 建立文字子區、設定與還原頻道內的成員權限。 |
| Mention Everyone | 讓子區建立者透過 Bot 發送身分組及 everyone／here 通知。 |
| Manage Threads、Send Messages in Threads、Create Public Threads、Create Private Threads | 建立及管理討論串與論壇帖子、鎖定／封存及移除討論串成員。 |
| Add Reactions | 子區互動所需的反應權限。 |

在 **伺服器設定 → 身分組** 中，將機器人的身分組放在它需要管理的成員身分組上方。頻道覆寫權限也必須允許機器人檢視頻道及執行對應操作。

若從尚未具備子區及置頂權限的舊版升級，請重新執行 `npm run invite`，開啟新網址並對同一伺服器完成授權。已具備這些權限的部署，新增訊息 APP 選單時不需要重新邀請機器人。機器人仍無須 Administrator。

## 4. 啟動

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
| `/config logs [channel]` | 設定本服日誌通知頻道；省略停用通知，本機案件仍保存。 | Manage Server |
| `/config welcome [channel]` | 設定歡迎頻道；省略頻道則停用。 | Manage Server |
| `/config welcome-message message` | 設定歡迎訊息範本，最多 1,000 字元。 | Manage Server |
| `/config appeals [channel]` | 設定私人申訴通知頻道；省略則停用頻道通知。 | Manage Server |
| `/config subareas [category] [forum]` | 設定開放建立子區的分類／論壇；兩者皆省略則停用新建。 | Manage Server |
| `/access grant user scope` | 授予指定或全部 Bot 管理功能。 | 伺服器擁有者或原生 Administrator |
| `/access revoke user [scope]` | 撤回指定授權；省略則撤回全部。 | 伺服器擁有者或原生 Administrator |
| `/access list [user]` | 查看本伺服器的管理授權。 | 伺服器擁有者或原生 Administrator |
| `/appeal submit [case]` | 開啟表單，申訴自己的案件；省略使用最近處罰。 | 案件當事人，可於伺服器或 Bot 私訊使用 |
| `/appeal status [id]` | 查詢自己的申訴工單。 | 工單申訴人 |
| `/appeal queue [id] [status]` | 查看工單清單或指定工單完整內容。 | 原生 Manage Server 或伺服器擁有者 |
| `/appeal review id result reason` | 通過或駁回申訴並記錄處理說明。 | 原生 Manage Server 或伺服器擁有者 |
| `/subarea create name [type] [parent] [content]` | 建立獨立文字頻道、討論串或論壇帖子；預設文字頻道。 | 可查看並在開放目的地建立的成員，已登記子區少於 3 個才可再建立 |
| `/subarea assign channel user` | 登記文字頻道／討論串；原生用戶建立的討論串保留原帖主。 | 伺服器擁有者或原生 Administrator |
| `/subarea list` | 查看自己建立的子區。 | 一般成員 |
| `/subarea mute user reason` | 在目前子區禁言；文字頻道覆寫權限，討論串監聽後刪訊息及反應。 | 該子區建立者、協管或原生 Administrator |
| `/subarea unmute user [reason]` | 解除目前子區的禁言。 | 該子區建立者、協管或原生 Administrator |
| `/subarea kick user reason` | 文字子區禁止查看；討論串僅移除成員，公開討論串仍可重新加入。 | 該子區建立者、協管或原生 Administrator |
| `/subarea unkick user [reason]` | 恢復文字子區存取或將成員重新加入討論串。 | 該子區建立者、協管或原生 Administrator |
| `/subarea tag user [message]` | 透過 Bot 提及指定用戶。 | 僅目前子區建立者 |
| `/subarea role-tag role [message]` | 透過 Bot 提及指定身分組。 | 僅目前子區建立者 |
| `/subarea announce audience message` | 在子區通知 `everyone` 或 `here`。 | 僅目前子區建立者 |
| `/subarea pin message` | 標註（置頂）目前子區的指定訊息。 | 僅目前子區建立者 |
| `/subarea unpin message` | 取消標註（置頂）。 | 僅目前子區建立者 |
| `/subarea delete-message message` | 刪除目前子區的指定訊息。 | 該子區建立者、協管或原生 Administrator |
| `/subarea slowmode seconds` | 設定 0 至 21,600 秒慢速模式，0 為關閉。 | 該子區建立者、協管或原生 Administrator |
| `/subarea rename name` | 修改目前子區名稱。 | 該子區建立者、協管或原生 Administrator |
| `/subarea lock`、`/subarea unlock` | 鎖定／解鎖；討論串鎖定會一併封存。 | 該子區建立者、協管或原生 Administrator |
| `/subarea delete` | 經兩次確認後刪除自己的子區。 | 僅目前子區建立者 |
| `/subarea delegate user`、`/subarea undelegate user` | 授予／撤回目前子區協管。 | 該子區建立者或原生 Administrator |
| `/subarea delegates`、`/subarea info` | 查看協管及子區管理資訊。 | 該子區建立者、協管或原生 Administrator |
| `/admin cases [user]`、`/admin case id` | 查看本伺服器近期案件或指定案件完整紀錄。 | 原生 Manage Server |
| `/admin warning-remove id reason` | 確認後移除警告，保存原案件及移除紀錄。 | 原生 Manage Server |
| `/admin role-add user role reason`、`/admin role-remove user role reason` | 新增／移除成員身分組。 | 原生 Manage Server 與 Manage Roles |
| `/admin channel-edit channel reason [name] [slowmode] [nsfw]` | 編輯文字／公告頻道名稱、慢速模式或年齡限制。 | 原生 Manage Server 與 Manage Channels |

踢出、封鎖與清理訊息會先顯示僅操作者可見的確認按鈕，30 秒後失效。執行時仍會重新檢查權限。無法管理伺服器擁有者、自己或機器人本身，也不能對同級或較高角色成員執行受限制的操作；伺服器擁有者執行的 Discord 管理操作仍受機器人角色階級限制。本機警告紀錄不需要機器人修改目標角色。Discord 不允許對管理員或機器人成員設定禁言。

清理功能支援伺服器的文字及公告頻道。Discord 批次刪除限制只允許清理未滿 14 天的訊息，因此送出數量可能少於要求數量。確認期間新到達的訊息不會加入刪除範圍。清理結果會回報送出數量；Discord 不回傳批次操作的實際刪除數量，其他管理員同時刪除訊息也可能影響結果。刪除、踢出與封鎖會立即影響伺服器，請先在測試頻道驗證。

### 訊息 APP 選單

可直接對選中的訊息置頂或刪除，無須先複製訊息連結或 ID；原有的 `/subarea pin`、`unpin` 與 `delete-message` 指令仍可使用。

- **手機：** 長按要操作的訊息 → **APP** → 選擇機器人的操作。
- **電腦：** 右鍵點擊要操作的訊息 → **Apps／應用程式** → 選擇操作。

| APP 操作 | 功能 | 操作者權限 |
| --- | --- | --- |
| `標註／取消標註` | 尚未置頂的訊息會置頂，已置頂則取消；依執行時的訊息狀態判斷。 | 已登記子區僅限目前建立者；一般文字／公告頻道需原生 Pin Messages 權限。 |
| `刪除訊息` | 確認後刪除所選的單則訊息，確認按鈕 30 秒後失效。 | 已登記子區限建立者、該區協管或原生 Administrator；一般文字／公告頻道需原生 Manage Messages 權限。 |

選單可用於獨立文字子區及討論串／論壇帖子。用戶原生建立的帖子會沿用既有的帖主登記方式；私密討論串仍會另外檢查成員資格。Bot 需要對應的查看、歷史、Pin Messages 或 Manage Messages 權限。子區的「標註」仍只限建立者，協管與其他管理員不能藉 APP 選單代替建立者置頂。

確認提示和操作結果僅操作者可見。程式只操作所選訊息所在的同一伺服器與頻道，會在執行前重新檢查權限，並保存本服案件紀錄。訊息 APP 操作不需要開啟 Message Content Intent。

選單需透過伺服器安裝的機器人使用，邀請範圍須包含 `applications.commands`。若更新後未看到選單，確認服務已成功啟動並註冊，再重新開啟 Discord；全域指令可能仍在傳播。單純新增 APP 選單無須執行 `commands:sync`，該工具用於處理重用 Bot 時遺留的舊指令。

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

### 子區管理：文字頻道、討論串與論壇帖子

保留既有獨立文字子區，並支援 Discord 討論串及論壇帖子。先由管理員開放建立範圍；可同時設定分類與論壇，或只提供其中一項。兩者都不提供會停用新建，既有子區仍可管理：

```text
/config subareas category:社群子區 forum:#交流論壇
```

預設建立獨立文字頻道；討論串需指定已開放分類內的文字母頻道，論壇帖子需使用已開放論壇或開放分類內的論壇：

```text
/subarea create name:小明的討論區
```

```text
/subarea create name:活動討論 type:thread parent:#活動大廳
```

```text
/subarea create name:作品交流 type:forum parent:#交流論壇 content:歡迎交流作品。
```

建立者須能查看目的地並具備對應的 Discord 建立權限；同一用戶在該伺服器已有 3 個已登記子區時，Bot 不再替其建立新子區。新文字子區繼承分類的可見範圍，Bot 不會把伺服器的 Manage Channels 或 Manage Roles 授予建立者。用戶自己建立的既有討論串／論壇帖子可在帖內使用管理指令，Bot 會記錄原生帖主；Bot 建立的討論串則以本機保存的建立者為準。

管理員可登記既有文字頻道，或指派 Bot 建立子區的新管理者；用戶原生建立的討論串須維持 Discord 原帖主，不能藉登記冒充其他用戶的帖子：

```text
/subarea assign channel:#小明的討論區 user:@小明
```

#### 協管與日常操作

建立者或原生 Administrator 可授予目前子區的協管。協管可禁言、移除成員、刪訊息、改名、調整慢速模式及鎖定／解鎖，但不能再授權協管、刪除整個子區、置頂訊息或代替建立者發送提及。更換子區建立者會撤回舊協管；其他子區不受影響。

```text
/subarea delegate user:@協管
```

```text
/subarea delegates
```

```text
/subarea undelegate user:@協管
```

「標註」明確指訊息置頂，與 `tag` 的 @ 提及分開。`message` 接受目前子區的 Discord 訊息連結或訊息 ID；其他頻道的訊息不能透過此子區管理：

```text
/subarea pin message:訊息連結或ID
```

```text
/subarea unpin message:訊息連結或ID
```

```text
/subarea delete-message message:訊息連結或ID
```

```text
/subarea slowmode seconds:10
```

```text
/subarea rename name:新的子區名稱
```

```text
/subarea lock
```

```text
/subarea unlock
```

文字頻道鎖定會保存原有權限，禁止一般成員發言，並保留 Bot／目前建立者的管理能力。解鎖時還原受管理的權限項目，保留其他權限變動和仍有效的個別成員限制；原生 Administrator 依 Discord 規則可繞過頻道限制。討論串鎖定採用 Discord 的鎖定及封存，解鎖會解除封存。建立者使用 `/subarea delete` 須完成兩次限時確認，刪除無法還原。

私密討論串會另外確認操作者仍是該討論串的成員；只具備父頻道的查看權限不足以使用子區管理功能。原生具有該頻道 Manage Threads 權限的管理人員依 Discord 規則可存取私密討論串。文字子區鎖定時請先解鎖，再轉移建立者。

#### 子區禁言與移除成員

```text
/subarea mute user:@用戶 reason:持續洗版
```

```text
/subarea kick user:@用戶 reason:違反本子區規則
```

```text
/subarea unmute user:@用戶
```

```text
/subarea unkick user:@用戶
```

兩種子區依 Discord 提供的能力採不同機制：

| 子區類型 | 禁言 | 移除成員 |
| --- | --- | --- |
| 獨立文字頻道 | 頻道覆寫禁止發言、討論串發言與建立、以及新增反應；Bot 離線仍有效。 | 禁止查看及進入該頻道，不踢出伺服器。 |
| 討論串／論壇帖子 | Bot 收到消息或新增反應事件後刪除；Bot 必須在線，訊息可能短暫出現。 | 從討論串成員名單移除；公開討論串仍可能查看及重新加入，不代表永久封鎖。 |

子區操作不會自動升級為全伺服器禁言或封鎖。文字頻道的禁言與禁止進入可同時存在，解除其中一種保留另一種，並還原 Bot 管理的權限項目。Bot 不允許子區管理者限制伺服器管理員、建立者、自己或機器人。

#### 建立者提及通知

以下 @ 提及指令僅限目前建立者，管理員和協管亦不能代替其他人的子區發送；每個子區每 30 秒可使用一次：

```text
/subarea tag user:@用戶 message:請查看本區規則
```

```text
/subarea role-tag role:@活動成員 message:活動即將開始
```

```text
/subarea announce audience:everyone message:本區公告
```

新建文字子區會把 Mention Everyone 權限保留給建立者及 Bot。這不會禁止 Discord 本身允許的個別用戶提及，或提及已設定為可提及的身分組；原生 Administrator 亦可繞過頻道覆寫。討論串沿用母頻道的原生權限，Bot 提供的三種指令仍嚴格檢查建立者身分。

### 管理員工具

`/admin` 僅限具備原生 Manage Server 的用戶；單靠 `/access` Bot 管理授權不能使用。身分組及頻道操作還會檢查對應的原生管理權限、操作者與 Bot 的角色階級，以及目標頻道的查看權限。

```text
/admin cases
```

```text
/admin cases user:@用戶
```

```text
/admin case id:1
```

```text
/admin warning-remove id:1 reason:已確認誤判
```

`warning-remove` 的 `id` 是 `/warnings` 顯示的警告編號，與管理案件編號不同。確認後移除有效警告，不刪除原始管理案件；移除操作另留紀錄。

```text
/admin role-add user:@用戶 role:@活動成員 reason:參加活動
```

```text
/admin role-remove user:@用戶 role:@活動成員 reason:活動結束
```

不能操作 `@everyone`、Discord 託管身分組、自己、Bot、伺服器擁有者或受保護管理員，目標成員與身分組均須低於操作者及 Bot 的可管理階級。一般伺服器管理者不能透過此功能發放或移除帶有高危管理權限的身分組；原生 Administrator 仍受角色階級和 Bot 權限限制。

```text
/admin channel-edit channel:#活動大廳 reason:活動開始 slowmode:10 name:活動交流
```

頻道編輯限文字／公告頻道，可修改名稱及 `nsfw`；慢速模式僅限文字頻道，公告頻道不接受此選項。至少指定一個變更項目；保留其他頻道設定與權限覆寫。每次變更都記錄原因，等待確認或讀取目標後會重新檢查權限。

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

設定、警告、管理授權、申訴工單、子區建立者、協管、文字頻道鎖定快照與限制狀態都保存在 SQLite，重新啟動後仍會保留，各伺服器資料分開查詢。首次啟動新版時會自動新增資料表及設定欄位，保留舊的警告、案件與設定。文字子區限制同時保存在 Discord 頻道覆寫中，不依賴 Bot 持續在線才生效；討論串禁言依賴 Bot 在線接收事件。

管理紀錄頻道是額外通知；頻道被刪除或失去發送權限時，通知失敗不代表已成功的管理操作會撤回。也可透過 Discord 原生稽核紀錄查看 Discord 支援的管理操作。

**每個伺服器的案件編號獨立計算。** A 服的案件從 #1、#2 累加，不會占用 B 服的案件編號。日誌頻道、案件查詢與申訴使用各自伺服器的案件；回覆顯示「本服案件 #N」。未設定 `/config logs` 仍會保存本機案件，供查詢與申訴使用，但不向任何日誌頻道發送通知。

升級時會依各服原有案件的先後順序建立本服編號，保留案件內容及既有申訴關聯。舊版訊息上的共用流水號可能與新版本服編號不同，請用 `/admin cases` 查看目前編號。私訊中若多個伺服器都有同一案件編號，請從對應伺服器的處罰通知按鈕開啟申訴；Bot 不會替你猜選哪個伺服器。

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

若 Bot 尚缺子區或置頂權限，才需執行下列命令，開啟網址對原伺服器重新授權。已具備 Manage Channels、Manage Roles、Manage Threads、Pin Messages 與討論串發言／建立等權限時，可直接繼續啟動服務：

```sh
sudo -u discordbot -H npm --prefix /opt/discord-manager run invite
```

啟動並自動註冊新版指令：

```sh
sudo systemctl start discord-manager
```

檢查啟動結果：

```sh
sudo journalctl -u discord-manager -n 50 --no-pager
```

最後在 Discord 設定私人申訴頻道、子區分類及論壇，再依需要授權用戶：

```text
/config appeals channel:#申訴審核
```

```text
/config subareas category:社群子區 forum:#交流論壇
```

```text
/access grant user:@小明 scope:timeout
```

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

## 常見問題

- **指令沒有出現：** 確認機器人已成功啟動並完成自動註冊，且邀請包含 `applications.commands`。若有設定 `DISCORD_GUILD_ID`，確認是目前伺服器；全域指令可能仍在更新。也可執行 `npm run register` 手動重試。
- **訊息 APP 選單沒有出現：** 在訊息上長按／右鍵，進入 APP／Apps 選單，確認目前伺服器已安裝此 Bot。更新並重啟 Bot 後重新開啟 Discord，等待全域指令傳播；既有 Slash Commands 不會因新增選單而移除。
- **Missing Permissions 或無法管理某位成員：** 檢查機器人及操作者的功能權限、頻道覆寫權限，以及雙方的最高角色位置。
- **授權後看不到管理指令：** 查看伺服器設定中的應用程式整合與指令使用權限。Bot 授權不會移除 Discord 另外設定的指令禁止規則。
- **申訴沒有出現在頻道：** 用 `/appeal queue` 確認工單是否已保存，並檢查 `/config appeals`、頻道私人設定及 Bot 的發送／嵌入連結權限。
- **子區無法建立或限制成員：** 重新使用新版邀請網址授權子區、討論串及置頂權限，確認已設定 `/config subareas`，並檢查母頻道／分類覆寫與 Bot 角色位置。
- **討論串移除後仍可加入：** 公開討論串移除成員只會移出成員名單，無法原生禁止查看或重新加入；需永久隔離時使用獨立文字子區的存取限制。
- **討論串禁言沒有刪訊息：** 確認 Bot 在線、有 Manage Messages 與查看／歷史權限，且目前討論串已登記；此機制不會在 Discord 原生輸入框禁止發言。
- **歡迎訊息沒有出現：** 確認已設定歡迎頻道、開啟 Server Members Intent，且機器人能在該頻道發送訊息。
- **Disallowed Intents：** 在 Developer Portal 開啟 Server Members Intent，再重新啟動。需要審核的 Application 必須先取得 Discord 核准。
- **重新部署後資料消失：** 確認 `DATABASE_PATH` 指向持久磁碟，而非部署時會清空的暫存目錄。
- **Token 外洩：** 立即在 Developer Portal 重設 Token、更新主機上的設定並重新啟動，從版本紀錄及公開內容移除舊 Token。
