# 常見問題

[專案首頁](../README.md) · [安裝](installation.md) · [使用指南](commands.md) · [部署更新](deployment.md) · [常見問題](troubleshooting.md)

先依症狀檢查設定、權限與日誌；問題仍在時，可到 [Issues](https://github.com/Hum404/discord-server-manager/issues) 回報。

## 常見問題

- **指令沒有出現：** 確認機器人已成功啟動並完成自動註冊，且邀請包含 `applications.commands`。若有設定 `DISCORD_GUILD_ID`，確認是目前伺服器；全域指令可能仍在更新。也可執行 `npm run register` 手動重試。
- **指令名稱仍是英文：** 確認 Discord 介面語言為繁體中文或簡體中文，且 Bot 已更新並重啟完成註冊；重新開啟 Discord 並等待全域指令更新。英文介面的主要指令會繼續顯示英文名稱，無須更改 Token 或清除舊指令。
- **用簡體搜尋不到指令：** 更新並重啟 Bot 完成相容入口註冊後，重新開啟 Discord，再輸入 `/子区`、`/设置` 或 `/申诉`。主要繁體入口仍保留，簡體入口使用相同的權限及功能；「警告」「禁言」「踢出」等簡繁相同的名稱共用既有入口。
- **訊息 APP 選單沒有出現：** 在訊息上長按／右鍵，進入 APP／Apps 選單，確認目前伺服器已安裝此 Bot。更新並重啟 Bot 後重新開啟 Discord，等待全域指令傳播；既有 Slash Commands 不會因新增選單而移除。
- **Missing Permissions 或無法管理某位成員：** 檢查機器人及操作者的功能權限、頻道覆寫權限，以及雙方的最高角色位置。
- **授權後看不到管理指令：** 查看伺服器設定中的應用程式整合與指令使用權限。Bot 授權不會移除 Discord 另外設定的指令禁止規則。
- **申訴沒有出現在頻道：** 用 `/appeal queue` 確認工單是否已保存，並檢查 `/config appeals`、頻道私人設定及 Bot 的發送／嵌入連結權限。
- **伺服器處罰公告沒有出現：** 以 `/config punishments` 確認 `enabled` 與位置，執行 `/config punishment-test` 檢查權限；討論串／帖子需未封存、未原生鎖定且 Bot 能發言。公告設定按伺服器分開，與 `/config logs` 及私訊開關互不替代。
- **子區管理通知沒有出現：** 以 `/config subarea-notices` 查看開關，必要時設定 `enabled:true`；Bot 需能在操作的子區內查看、發送訊息及嵌入連結。此通知預設開啟，不使用伺服器處罰公告的位置或開關，失敗時也不會轉發到其他頻道。
- **子區無法建立或限制成員：** 重新使用新版邀請網址授權子區、討論串及置頂權限，確認已設定 `/config subareas`，並檢查母頻道／分類覆寫與 Bot 角色位置。
- **討論串移除後仍可加入：** 公開討論串移除成員只會移出成員名單，無法原生禁止查看或重新加入；需永久隔離時使用獨立文字子區的存取限制。
- **討論串禁言沒有刪訊息：** 確認 Bot 在線、有 Manage Messages 與查看／歷史權限，且目前討論串已登記；此機制不會在 Discord 原生輸入框禁止發言。
- **歡迎訊息沒有出現：** 確認已設定歡迎頻道、開啟 Server Members Intent，且機器人能在該頻道發送訊息。
- **Disallowed Intents：** 在 Developer Portal 開啟 Server Members Intent，再重新啟動。需要審核的 Application 必須先取得 Discord 核准。
- **重新部署後資料消失：** 確認 `DATABASE_PATH` 指向持久磁碟，而非部署時會清空的暫存目錄。
- **Token 外洩：** 立即在 Developer Portal 重設 Token、更新主機上的設定並重新啟動，從版本紀錄及公開內容移除舊 Token。
