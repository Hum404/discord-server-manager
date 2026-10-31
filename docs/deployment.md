# 部署與更新

[專案首頁](../README.md) · [安裝](installation.md) · [使用指南](commands.md) · [部署更新](deployment.md) · [常見問題](troubleshooting.md)

適用於現有阿里雲主機的更新步驟；首次安裝請先閱讀[安裝指南](installation.md)。

## 阿里雲現有部署更新

以下沿用 `/opt/discord-manager`、`discordbot` 帳號及 `discord-manager` systemd 服務。每次只執行一個命令區塊；保留原本 `.env`，不需要重新填 Token 或 ID。本次鎖定升級會自動遷移 SQLite 鎖定紀錄，沿用目前通知設定；請確認 Bot 原有 Manage Threads 權限仍有效。完整更新順序為**停止、備份、下載、編譯、啟動**。若前一步執行失敗，先處理錯誤再繼續下一步。

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
sudo systemctl start discord-manager
```

檢查啟動結果：

```sh
sudo journalctl -u discord-manager -n 50 --no-pager
```

若日誌顯示 Bot 缺少子區或置頂權限，才需執行下列命令，開啟網址對原伺服器重新授權。已具備 Manage Channels、Manage Roles、Manage Threads、Pin Messages 與討論串發言／建立等權限時可略過：

```sh
sudo -u discordbot -H npm --prefix /opt/discord-manager run invite
```

只有要更改通知頻道或子區開放範圍時，才需在 Discord 更新設定；原有設定會繼續使用：

```text
/config appeals channel:#申訴審核
```

```text
/config subareas category:社群子區 forum:#交流論壇
```

```text
/access grant user:@小明 scope:timeout
```
