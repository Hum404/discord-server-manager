# 更新紀錄

[專案首頁](README.md) · [部署更新](docs/deployment.md)

## 2026-10-31

### 子區鎖定

- 討論串與論壇帖子改用 Discord 原生鎖定及封存，Bot 離線後仍有效。
- 一般鎖定可依通知設定私訊建立者解鎖按鈕；按鈕在 Bot 重啟後仍可使用。
- 透過 Bot 發起的管理員處分鎖，禁止建立者或協管自行解除；管理員可接管原有的一般鎖定。
- 鎖定預告、建立者私訊與實際鎖定結果分開處理。通知失敗不會撤回已完成的鎖定。
- 舊版鎖定保留原有資料，來源不明時需由管理員確認解鎖。升級步驟見[部署更新](docs/deployment.md)。

[變更內容](https://github.com/Hum404/discord-server-manager/commit/45b28e271ee8f377b5e9c7ace43257e7b2e600ea)

### 專案文件

- 首頁改為功能介紹與使用入口。
- 安裝、指令、部署與常見問題分頁整理。
- 新增此更新紀錄。

## 2026-10-30

- 公布[隱私政策](PRIVACY_POLICY.md)與[服務條款](TERMS_OF_SERVICE.md)，說明資料用途、保存方式及聯絡管道。

[變更內容](https://github.com/Hum404/discord-server-manager/commit/5a26ccd984de72d16d3380998076d193f650eb43)

## 2026-10-29

- 新增 `/通知設定` 私人卡片，可在下拉選單切換管理通知與子區通知，逐項選擇要發送的操作。
- 子區管理通知預設在實際操作的子區內發送，管理員可調整開關及項目。
- 主要指令名稱統一為繁體中文，另保留簡體指令入口。
- 新增可配置的伺服器處罰公告與私訊開關。

[通知卡片](https://github.com/Hum404/discord-server-manager/commit/d82db1fa721fb15ac3d01acfb1cb1d0f61bc9ad5) · [簡體指令入口](https://github.com/Hum404/discord-server-manager/commit/3523c85dbe1146ef00487f17ef0ed3d4901ba8c8)

## 2026-10-28

- 新增訊息 APP 選單，可直接操作所選訊息的置頂與刪除。
- 伺服器處罰日誌與成員操作紀錄分流，子區日常管理不再發送至全服日誌頻道。
- 加入從其他頻道指定子區解鎖的入口。

[訊息 APP 選單](https://github.com/Hum404/discord-server-manager/commit/3b92d1f3f647dfe65b99d2603563b4c52e57c1df) · [紀錄分流](https://github.com/Hum404/discord-server-manager/commit/a78b5dde284376277614cff4b9d8945c80906e44)
