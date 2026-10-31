# 使用指南

[專案首頁](../README.md) · [安裝](installation.md) · [使用指南](commands.md) · [部署更新](deployment.md) · [常見問題](troubleshooting.md)

指令、權限與常用操作的完整說明。中文介面可直接使用對應的中文指令；下方指令表保留英文名稱，方便查找參數。

## 指令

### 中文指令名稱

Bot 的主要 Slash 指令、子指令、參數、選項及 APP 選單在中文介面統一使用繁體中文，與說明和回覆一致。同時保留簡體指令入口，輸入 `/子区`、`/设置`、`/申诉` 等簡體字也能找到並使用對應功能；簡體入口的名稱、子指令與參數以簡體顯示，執行結果及說明仍使用繁體。英文介面的主要 Slash 名稱維持英文。下方完整指令表與既有範例保留英文識別名稱，便於對照程式與舊版教學。

Discord 沒有隱藏的搜尋別名，因此簡體相容入口也會出現在指令選單中。簡繁名稱相同的指令（例如「警告」「禁言」「踢出」）沿用同一個入口，不會重複註冊。Discord 本身的「所有命令」「熱門」等介面文字仍由 Discord 的語言設定決定。

| 文件中的英文名稱 | 中文介面統一顯示 |
| --- | --- |
| `/subarea create` | `/子區 建立` |
| `/subarea delegate` | `/子區 設定協管` |
| `/subarea mute` | `/子區 禁言` |
| `/config subarea-notices` | `/設定 子區通知` |
| `/config punishments` | `/設定 處罰通知` |
| `/notifications` | `/通知設定` |

例如，在任一中文介面設定協管：

```text
/子區 設定協管 成員:@小明
```

也可使用簡體入口搜尋及執行同一個功能：

```text
/子区 设置协管 成员:@小明
```

管理員關閉子區內通知：

```text
/設定 子區通知 啟用:false
```

繁體與簡體入口使用相同的功能、權限檢查、管理授權及案件紀錄；選擇任一入口只執行一次操作。兩者仍會重新檢查角色與子區權限，簡體入口不能繞過原有的限制。更新程式並重啟 Bot 後，啟動流程會自動註冊名稱及相容入口；重新開啟 Discord，並等待全域指令更新。單純更新中文顯示無須重新填 Token、重新邀請 Bot 或執行 `commands:sync` 清理。

### 完整指令表

`/help` 與 `/ping` 提供一般說明及連線狀態。管理指令允許受授權用戶在 Discord 選單中看到，因此一般成員也可能看得到；執行時仍會檢查原生權限或 Bot 授權、角色階級及機器人權限。

| 指令 | 功能 | 操作者權限 |
| --- | --- | --- |
| `/help` | 查看使用說明。 | 一般成員 |
| `/ping` | 查看機器人延遲。 | 一般成員 |
| `/notifications [kind]` | 直接開啟通知設定卡片，在下拉選單選擇管理／子區通知並勾選項目。 | 原生 Manage Server |
| `/records [user] [id] [direction]` | 查看本服成員操作紀錄；預設自己的執行紀錄，可切換收到的操作。 | 一般成員可看自己；查看他人需原生 Manage Server 或伺服器擁有者 |
| `/warn user reason` | 新增成員警告，保存管理者及原因。 | Moderate Members 或 `warn` 授權 |
| `/warnings user` | 查看該成員最近 10 筆警告及總數。 | Moderate Members 或 `warn` 授權 |
| `/timeout user minutes reason` | 禁言 1 至 40,320 分鐘（28 天）。 | Moderate Members 或 `timeout` 授權 |
| `/untimeout user reason` | 解除禁言。 | Moderate Members 或 `timeout` 授權 |
| `/kick user reason` | 確認後踢出成員。 | Kick Members 或 `kick` 授權 |
| `/ban user reason [delete_days]` | 確認後封鎖成員；可選擇刪除最近 0 至 7 天訊息。 | Ban Members 或 `ban` 授權 |
| `/unban user_id reason` | 依 Discord 使用者 ID 解除封鎖。 | Ban Members 或 `ban` 授權 |
| `/clear amount` | 確認後清理目前頻道的 1 至 100 則訊息。 | Manage Messages 或 `clear` 授權；仍需查看及讀取頻道歷史 |
| `/config view` | 查看此伺服器的設定。 | Manage Server |
| `/config logs [channel]` | 設定本服伺服器處罰日誌頻道；子區等成員操作不發到此頻道。省略停用通知，本機紀錄仍保存。 | Manage Server |
| `/config punishments [channel] [channel-id] [enabled] [dm] [include-subareas]` | 設定伺服器處罰公告位置與公告／私訊開關；目標擇一填寫，無參數則查看設定。`include-subareas` 為子區內通知開關的相容選項。 | 原生 Manage Server |
| `/config subarea-notices [enabled]` | 開關直接發送至子區內的管理通知，預設開啟；無參數則查看目前狀態。 | 原生 Manage Server |
| `/config notification-actions [kind]` | 開啟通知設定卡片，在卡片內切換管理／子區通知並勾選項目；可選參數用於直接開啟指定類型。 | 原生 Manage Server |
| `/config punishment-test` | 向已啟用的處罰公告位置發送測試通知，不執行處罰或建立案件。 | 原生 Manage Server |
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
| `/subarea lock [channel] [channel-id]`、`/subarea unlock [channel] [channel-id]` | 文字子區使用權限鎖定；討論串／論壇帖子原生鎖定並封存。可從其他頻道指定子區，兩種目標擇一填寫。 | 該子區建立者、協管、伺服器擁有者或原生 Administrator；管理員處分鎖與來源未確認的舊鎖僅限管理員處理 |
| `/subarea delete` | 經兩次確認後刪除自己的子區。 | 僅目前子區建立者 |
| `/subarea delegate user`、`/subarea undelegate user` | 授予／撤回目前子區協管。 | 該子區建立者或原生 Administrator |
| `/subarea delegates`、`/subarea info` | 查看協管及子區管理資訊。 | 該子區建立者、協管或原生 Administrator |
| `/admin cases [user]`、`/admin case id` | 查看本伺服器的處罰案件；成員操作改用 `/records`。 | 原生 Manage Server |
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

確認提示和操作結果僅操作者可見。程式只操作所選訊息所在的同一伺服器與頻道，會在執行前重新檢查權限，並保存成員操作紀錄；置頂或刪除單則訊息不會發送到伺服器處罰日誌頻道。訊息 APP 操作不需要開啟 Message Content Intent。

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

### 處罰、子區管理公告與私訊設定

原生具有 Manage Server 權限的管理員可指定本伺服器的處罰公告位置。伺服器處罰公告預設關閉，處罰前私訊預設開啟。子區管理通知則預設開啟，直接發送至操作的子區內，無須指定公告位置；管理員可獨立開關。設定保存在 SQLite，升級後無須重新填入 Token。

指定文字頻道、公告頻道、討論串或論壇帖子。提供新目標時會開啟公告，也可明確設定 `enabled:false`：

```text
/config punishments channel:#處罰公告 enabled:true dm:true
```

若討論串／帖子沒有出現在選單，可改用其 ID 或本服連結；`channel` 與 `channel-id` 只能擇一填寫。論壇父頻道不能直接作為發送位置，請選擇其中一篇帖子：

```text
/config punishments channel-id:123456789012345678 enabled:true
```

```text
/config punishments channel-id:https://discord.com/channels/伺服器ID/帖子ID enabled:true
```

測試目前位置；訊息會清楚標示為測試，不會處罰成員或產生案件：

```text
/config punishment-test
```

公告在處罰完成、案件保存後發送，包含處罰種類、對象、執行者、原因、時長等詳細內容、範圍、時間與本服編號；可申訴的處罰附上當事人的申訴入口。預設公告警告、伺服器禁言、踢出、封鎖，以及解除禁言、解除封鎖、撤銷警告。通知中的用戶與原因不會觸發 `@everyone`、身分組或用戶通知。

子區管理通知預設開啟，直接發送至操作的文字子區、討論串或論壇帖子內。建立者、協管及管理員執行禁言／解除禁言、移除／恢復成員、設定／撤回協管、建立／指派子區建立者、置頂／取消置頂、刪除訊息、慢速模式、改名、鎖定／解鎖時，無須另外設定目的地。若從其他頻道指定子區進行解鎖，通知仍發往實際被操作的子區，避免把私密子區內容公開至外部頻道。

討論串鎖定會先在目標子區嘗試發送「鎖定申請」預告，再執行原生鎖定與封存；預告本身不代表操作已成功，是否完成以實際狀態及指令結果為準。確認成功後保存成員紀錄，並嘗試私訊建立者提供解鎖方式。這些通知遵守子區通知總開關與「鎖定子區」通知項目；公告或私訊失敗會單獨提示，不會取消鎖定，也不會為發送通知重新開啟帖子或改投其他頻道。

管理員可關閉本伺服器的子區內通知：

```text
/config subarea-notices enabled:false
```

重新開啟：

```text
/config subarea-notices enabled:true
```

只查看目前狀態：

```text
/config subarea-notices
```

這個開關與伺服器處罰公告的 `enabled`、公告位置及處罰私訊設定分開；未設定或停用伺服器處罰公告，子區內通知仍會正常發送。舊版 `/config punishments include-subareas:true`／`false` 保留為子區內通知開關的相容寫法，不會再把子區操作轉送至指定公告位置。新舊安裝在首次加入此獨立設定時均預設開啟；管理員之後的開關選擇會保存。

通知在操作完成並保存成員紀錄後發送，包含操作種類、執行者、對象或子區、原因、時間及成員紀錄編號。非處罰操作顯示為「子區管理通知」，不提供處罰申訴按鈕；子區禁言、移除仍保留當事人的申訴入口。原本的提及用戶、身分組及全體公告指令已會發送通知，不會再重複產生管理公告。刪除整個子區後無法在已刪除的位置發送通知，刪除操作仍會保存在成員紀錄。

這些操作仍屬於成員紀錄，透過 `/records` 查詢，不會轉送到 `/config logs` 的伺服器處罰日誌或 `/config punishments` 指定的公告位置。子區管理通知不會額外私訊協管或其他操作對象；`dm` 開關仍只控制既有的處罰前私訊。伺服器處罰公告與伺服器日誌可使用不同目的地；若設為同一頻道，已成功公告的同一筆伺服器處罰只發送一次。

只關閉公告、保留已設定的位置，或只關閉處罰前私訊：

```text
/config punishments enabled:false
```

```text
/config punishments dm:false
```

未提供的參數會保留原值；再次設定 `enabled:true` 可沿用已保存的位置。無參數的 `/config punishments` 及 `/config view` 可查看目前狀態。關閉私訊不會停用案件紀錄、公告或申訴指令；被踢出／封鎖後可能無法再查看伺服器公告，管理員應另行提供當事人可用的申訴入口。

Bot 需有目標的 View Channel、Embed Links，文字／公告頻道另需 Send Messages，討論串／帖子需 Send Messages in Threads；私密討論串還需符合成員或 Manage Threads 存取條件。目標必須屬於本伺服器，且討論串目前可發言；Bot 不會為了公告自動重新開啟已封存或原生鎖定的帖子。公告發送失敗時，處罰與本機紀錄仍保留，操作者會收到提示。啟用通知前，請確認目的地的查看權限符合該伺服器對處罰資訊的公開範圍。

### 選擇要通知的操作

管理員只需執行一條指令，即可開啟僅自己可見的「通知設定」卡片：

```text
/通知設定
```

也可使用簡體入口：

```text
/通知设置
```

先在卡片的下拉選單選擇「管理通知」或「子區通知」，再勾選需要的操作項目並按「儲存」。可使用「全選」或「清空」；清空後儲存表示該類型不發送任何項目。卡片會顯示該類通知目前的開關狀態及發送位置。

儲存後可直接在同一張卡片切換另一種類型繼續設定，無須再次輸入指令。切換類型時會保留各自尚未儲存的勾選；「儲存」只套用目前顯示的類型。關閉卡片或開啟滿 2 分鐘後，尚未儲存的變更會捨棄，已儲存的設定仍然有效。儲存時會重新確認管理員權限；若另一位管理員已修改同一類型，需重新開啟卡片，避免覆蓋對方的設定。

原本的 `/設定 通知項目` 及帶有 `通知類型` 參數的寫法仍可使用；指定類型會直接開啟該頁，省略參數即可從卡片內選擇。

| 通知類型 | 可選項目 | 發送位置 |
| --- | --- | --- |
| 管理通知 | 警告、伺服器禁言／解除禁言、踢出、封鎖／解除封鎖、撤銷警告，共 7 項。 | 原本設定的處罰公告與管理日誌頻道。 |
| 子區通知 | 建立／指派建立者、禁言／解除禁言、移除／恢復成員、設定／撤回協管、置頂／取消置頂、刪訊息、慢速模式、改名、鎖定／解鎖，共 15 項。 | 實際操作的子區內。 |

兩種類型按伺服器獨立保存，重啟後仍有效。未自訂時預設全選；自訂後只發送已勾選的項目。通知項目與原本的總開關、公告位置分開：選擇項目不會自動開啟已停用的公告或子區通知，也不會更改發送位置。

取消某項管理通知會同時停止該操作的處罰公告與管理日誌頻道訊息，但案件及成員紀錄仍照常保存，處罰與申訴功能不受影響。處罰前私訊由原本的 `dm` 開關控制，不受這個選單篩選。刪除整個子區後無法在已刪除的位置通知，原本自行發送訊息的用戶／身分組提及與全體通知也不列入此選單。

### 處罰申訴工單

先建立一個只有審核人員可見的文字頻道，再設定通知位置：

```text
/config appeals channel:#申訴審核
```

程式會檢查此頻道的 `@everyone`、非管理身分組及個別非管理成員都沒有查看權限，並確認 Bot 能查看、發送訊息及嵌入連結。審核人員需有原生 Manage Server 或 Administrator 權限；若其他普通身分組仍可查看，Bot 會拒絕發送工單內容。尚未設定通知頻道或通知失敗時，工單仍保存在 SQLite，管理員可使用 `/appeal queue` 查看。

處罰前私訊啟用時，警告、禁言、踢出、封鎖及子區處罰前，Bot 會先私訊申訴入口。操作完成且案件已保存後，當事人可按私訊中的「提交申訴」，或執行：

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

建立者或原生 Administrator 可授予目前子區的協管。協管可禁言、移除成員、刪訊息、改名、調整慢速模式及一般鎖定／解鎖，但不能解除管理員處分鎖、再授權協管、刪除整個子區、置頂訊息或代替建立者發送提及。更換子區建立者會撤回舊協管；其他子區不受影響。

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

文字頻道鎖定會保存原有權限，禁止一般成員發言，並明確保留 Bot／目前建立者的查看頻道、讀取歷史、發言及使用應用程式指令權限。這些權限只限該頻道，不會授予建立者 Administrator、Manage Roles 或 Manage Threads；能否解鎖仍依鎖定來源判斷。解鎖時還原受管理的權限項目，保留其他權限變動和仍有效的個別成員限制；原生 Administrator 依 Discord 規則可繞過頻道限制。文字頻道的原生權限限制在 Bot 離線時仍有效。

討論串／論壇帖子改用 Discord 原生「鎖定＋封存」（`locked: true`、`archived: true`），不修改父頻道權限，也不授予建立者 Manage Threads。鎖定完成後，Bot 離線仍會維持限制；一般建立者也無法在區內發言，需從外部解鎖。這項鎖定不再依靠收到訊息後刪除；原有個別成員禁言仍會保留，解鎖不會順便解除禁言。

每筆透過 Bot 執行的鎖定會記錄來源、操作者、模式與獨立識別碼。一般建立者或協管發起的鎖定，可由仍具該子區管理資格的人解除。**伺服器擁有者或具原生 Administrator 權限的人透過 Bot 發起的鎖定，一律記為管理員處分鎖，即使操作者同時也是建立者。** 處分鎖只能由上述管理員透過 Bot 解除；建立者、協管、Bot 管理授權及單獨的 Manage Server 權限都不能代替原生 Administrator。管理員可將一般鎖定接管為處分鎖，原有權限快照不變，舊解鎖按鈕會失效；建立者或協管不能藉重新鎖定降級處分鎖。Bot 目前不追蹤 Discord 原生介面每次手動切換鎖定的操作者；手動變更不會自動改寫既有鎖定的來源。持有 Discord 原生管理權限的人仍可依 Discord 規則直接管理帖子。

在子區通知已開啟且選取鎖定通知項目時，Bot 會嘗試私訊目前建立者。一般鎖定私訊附上「解鎖子區」按鈕；按鈕綁定伺服器、子區、該次鎖定與建立者，每次點擊都重新驗證權限，不依賴短期選單收集器，因此重啟後仍可使用。更換建立者、解除後重新鎖定、升級為處分鎖等變更會使舊按鈕失效。處分鎖或來源未確認的舊鎖只提供管理員處理說明，不提供建立者解鎖按鈕。通知關閉或私訊失敗時，仍可使用下方外部解鎖入口；通知結果與鎖定結果分開回報。

鎖定後無法在子區內執行指令時，可在同一伺服器的其他可用文字頻道指定目標解鎖：

```text
/subarea unlock channel:目標子區
```

若已封存帖子沒有出現在頻道選單，可填入該帖子的 ID、Discord 頻道連結或帖內訊息連結：

```text
/subarea unlock channel-id:帖子ID或連結
```

也可以從其他頻道鎖定自己有權管理的子區；`channel` 與 `channel-id` 擇一填寫，兩者都省略時仍操作目前子區：

```text
/subarea lock channel:目標子區
```

指定目標仍會檢查該子區的建立者／協管／管理員、查看權限、私密討論串成員資格及鎖定來源，不能藉其他頻道操作不屬於自己的子區或繞過處分鎖。

**舊版升級：** SQLite 會保留原有權限快照並補上鎖定資料欄位。啟動時，已保存的舊軟鎖定討論串會轉為原生鎖定並封存；文字子區則重新套用既有權限鎖定。舊紀錄沒有足夠資料判定當時屬於一般鎖定還是管理員處分，因此來源標為待確認，僅允許伺服器擁有者或原生 Administrator 解除／重新鎖定。Discord 上已原生鎖定（`locked: true`）、但沒有 Bot 鎖定紀錄的帖子，也須由管理員確認處理；僅因不活躍而自動封存、未被鎖定的帖子仍可由有權管理該子區的人重新開啟。Bot 不會為遷移或通知自行重新開啟帖子。更新沿用原本 Token 與其他資料，不需要重新填設定或替建立者新增管理身分組。

建立者使用 `/subarea delete` 須完成兩次限時確認，刪除無法還原。

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

### 伺服器處罰日誌與成員紀錄

`/config logs` 指定的頻道只接收伺服器層級的警告、禁言、踢出、封鎖及解除處罰通知：`warn`、`timeout`、`untimeout`、`kick`、`ban`、`unban`、`warning-remove`。`/admin cases` 和 `/admin case` 也只查詢這類案件；`user` 篩選的是被處罰的成員。

子區建立、指派、協管授權、置頂、刪訊息、慢速模式、鎖定，以及子區內的禁言／移除成員，改為成員紀錄。一般訊息 APP 操作、批次清理、設定、身分組與 Bot 授權變更、申訴流程操作也保存為成員紀錄，不發到上述日誌頻道。每筆保留執行者、操作對象、原因及可用的頻道資訊，回覆顯示「成員紀錄 #N」。子區內管理通知預設開啟，管理員可透過 `/config subarea-notices enabled:false` 關閉；通知只發送至操作的子區，不會改變紀錄的分類與查閱權限。

查看自己最近執行的操作：

```text
/records
```

查看自己收到的操作，或所有與自己相關的成員紀錄：

```text
/records direction:received
```

```text
/records direction:all
```

原生 Manage Server 管理員或伺服器擁有者可查看指定成員的紀錄；一般成員只能查閱自己的紀錄，子區建立者、協管或 Bot 管理授權不會自動取得查看其他成員歷史的權限：

```text
/records user:@成員 direction:all
```

指定紀錄編號可查看完整內容；編號仍需屬於所選成員及查詢方向：

```text
/records id:12
```

查詢結果僅操作者可見，資料按伺服器隔離，不會自動建立成員頻道或發送私訊。既有紀錄會依類型重新分類，不刪除原紀錄、不重編本服編號，子區處罰仍可提交申訴。已發送到 Discord 的舊日誌訊息不會自動刪除。

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

設定、警告、管理授權、申訴工單、子區建立者、協管、鎖定模式／來源／識別碼、文字頻道鎖定快照與限制狀態都保存在 SQLite，重新啟動後仍會保留，各伺服器資料分開查詢。首次啟動新版時會自動新增資料表及設定欄位，保留舊的警告、案件與設定。文字子區限制同時保存在 Discord 頻道覆寫中，討論串鎖定使用 Discord 原生鎖定與封存，完成後均不依賴 Bot 持續在線；討論串內個別成員禁言仍依賴 Bot 在線接收事件。

伺服器處罰日誌頻道是額外通知；頻道被刪除或失去發送權限時，通知失敗不代表已成功的處罰會撤回。成員操作只保存到本機紀錄並透過 `/records` 私下查詢。也可透過 Discord 原生稽核紀錄查看 Discord 支援的管理操作。

**每個伺服器的紀錄編號獨立計算。** A 服不會占用 B 服的編號。伺服器處罰與成員紀錄沿用同一本服唯一編號，因此分流查詢的編號可能不連續；原有編號與申訴關聯保持有效。處罰回覆顯示「本服案件 #N」，其他操作顯示「成員紀錄 #N」。未設定 `/config logs` 仍會保存本機紀錄，供查詢與申訴使用，但不向日誌頻道發送通知。

從較早的全域流水號版本升級時，會依各服原有案件的先後順序建立本服編號；已採本服編號的資料不會因本次日誌分流再次重編。舊版訊息上的全域流水號可能與本服編號不同，請用 `/admin cases` 或 `/records` 查詢。私訊中若多個伺服器都有同一案件編號，請從對應伺服器的處罰通知按鈕開啟申訴；Bot 不會替你猜選哪個伺服器。

請將資料庫放在持久磁碟並定期備份。複製資料庫前先正常停止機器人，再備份完整資料目錄；執行中的 SQLite 可能還有 `-wal` 與 `-shm` 檔案，僅複製主檔可能漏失資料。資料庫含使用者 ID、警告原因及管理紀錄，請限制檔案存取並按社群需求管理保存期限。
