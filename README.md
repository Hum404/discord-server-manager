# Discord Server Manager

給 Discord 社群使用的管理 Bot。提供成員處罰、子區協管、申訴工單與通知設定，支援獨立文字頻道、討論串和論壇帖子。

主要介面使用繁體中文，也能用簡體字搜尋及執行指令。

[部署指南](docs/installation.md) · [指令手冊](docs/commands.md) · [版本與更新](https://github.com/Hum404/discord-server-manager/releases) · [問題回報](https://github.com/Hum404/discord-server-manager/issues)

## 功能

| 功能 | 說明 |
| --- | --- |
| **成員管理** | 警告、禁言、踢出、封鎖與訊息清理。管理員可按功能授權指定成員。 |
| **子區管理** | 建立文字頻道、討論串或論壇帖子，設定協管、慢速模式、區內禁言及存取限制。置頂與提及通知由建立者操作。 |
| **處罰申訴** | 當事人透過表單提交工單，管理員查看案件並回覆審核結果。 |
| **通知與紀錄** | 選擇哪些操作要通知。伺服器處罰與子區操作分開處理，各服的設定和案件編號獨立。 |

## 在 Discord 裡操作

管理員輸入 `/通知設定`，就能在私人卡片上選擇管理通知或子區通知，勾選項目後儲存。

```text
/通知設定
```

子區管理使用 `/子區`；一般鎖定可由仍有權限的建立者或協管解除。管理員透過 Bot 發起的處分鎖，只能由伺服器擁有者或具 Discord「管理員」權限的人解除。

```text
/子區 鎖定
```

當事人可從處罰通知的按鈕開啟申訴，也能直接使用指令。

```text
/申訴 提交
```

置頂或刪除單則訊息時，可長按／右鍵訊息，從 **APP** 選單選擇「標註／取消標註」或「刪除訊息」。每次操作仍會檢查權限。

## 自行部署

需要 **Node.js 24+**、npm、Discord Bot Token，以及能持續運行並保存資料的主機。請先在 Discord Developer Portal 開啟 **Server Members Intent**。

部署時只需填入 Bot Token，Application ID 由程式取得；啟動後會自動註冊指令。資料使用 SQLite 保存，無須另外架設資料庫。

- **第一次安裝：** [安裝與設定](docs/installation.md)
- **最新版本與原始碼：** [Releases](https://github.com/Hum404/discord-server-manager/releases/latest)
- **更新現有主機：** [阿里雲部署更新](docs/deployment.md)，依序停止、備份、下載、編譯、啟動

## 版本與更新

每個版本的更新日誌、升級注意事項及原始碼下載，統一放在 [GitHub Releases](https://github.com/Hum404/discord-server-manager/releases)。更新前請先閱讀目標版本的說明。

每個 Release 的 **Assets** 都附上該版本的原始碼 ZIP 與 SHA-256 校驗檔。早期更新以 `history-日期-序號` 補登，對應當時的實際提交；新版本使用 `v` 開頭的版本號。

## 使用前留意

- 討論串內的**個別成員禁言**仍靠 Bot 刪除新訊息，需要 Bot 在線；與整個討論串的原生鎖定不同。
- 公開討論串移除成員後，對方仍可能重新加入；需要禁止查看時，使用獨立文字子區的存取限制。
- 申訴通過後，需由管理員另行撤銷處罰。
- 移除 Bot 或關閉通知不會自動刪除既有紀錄；資料保存與刪除請求方式見[隱私政策](PRIVACY_POLICY.md)。

## 文件

| 文件 | 內容 |
| --- | --- |
| [安裝與設定](docs/installation.md) | 建立 Bot、設定 Token、邀請權限與啟動 |
| [指令與權限](docs/commands.md) | 完整指令、子區管理、通知、授權及申訴 |
| [部署更新](docs/deployment.md) | 現有阿里雲主機的備份與更新步驟 |
| [常見問題](docs/troubleshooting.md) | 指令、權限、通知及連線問題 |
| [Releases](https://github.com/Hum404/discord-server-manager/releases) | 各版本的更新日誌與原始碼下載 |
| [隱私政策](PRIVACY_POLICY.md) · [服務條款](TERMS_OF_SERVICE.md) | 資料處理與使用規則 |

程式使用 TypeScript、discord.js 14 與 SQLite。測試與編譯指令見[開發檢查](docs/installation.md#檢查與測試)。

問題或功能建議請開 [Issue](https://github.com/Hum404/discord-server-manager/issues)。請附上使用情境、重現步驟與錯誤訊息；Token、資料庫和完整申訴內容請勿公開。
