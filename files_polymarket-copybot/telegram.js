import https from "https";

const BASE_URL = "https://api.telegram.org";

export class TelegramNotifier {
  constructor({ token, chatId, silent = false }) {
    this.token   = token;
    this.chatId  = chatId;
    this.silent  = silent;
    this.enabled = !!(token && chatId);
    if (!this.enabled)
      console.warn("⚠️  Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env");
  }

  async send(text) {
    if (!this.enabled) return;
    const body = JSON.stringify({
      chat_id: this.chatId, text, parse_mode: "HTML",
      disable_notification: this.silent, disable_web_page_preview: true,
    });
    return new Promise((resolve, reject) => {
      const req = https.request(
        `${BASE_URL}/bot${this.token}/sendMessage`,
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { const p = JSON.parse(d); if (!p.ok) console.warn("Telegram:", p.description); resolve(p); }); }
      );
      req.on("error", reject); req.write(body); req.end();
    });
  }

  async alertStartup({ yourWallet, targetWallet, dryRun, maxBet, copyRatio, dailyCap, stopLossUsd, stopLossPct, trailingStopUsd }) {
    const slLines = [
      stopLossUsd     ? `🔴 Fixed stop-loss: <b>$${stopLossUsd}</b>` : null,
      stopLossPct     ? `🔴 % stop-loss: <b>${(stopLossPct*100).toFixed(0)}% of balance</b>` : null,
      trailingStopUsd ? `🔴 Trailing stop: <b>$${trailingStopUsd} drawdown</b>` : null,
    ].filter(Boolean).join("\n");

    await this.send(
`🤖 <b>CopyBot started</b>

🎯 Target: <code>${shortAddr(targetWallet)}</code>
👛 Yours:  <code>${shortAddr(yourWallet)}</code>

⚙️ Max bet: <b>$${maxBet}</b>  |  Ratio: <b>${(copyRatio*100).toFixed(0)}%</b>  |  Daily cap: <b>$${dailyCap}</b>
${slLines ? "\n" + slLines : ""}
${dryRun ? "\n🔵 <b>DRY RUN MODE</b>" : "\n🟢 <b>LIVE MODE</b>"}`);
  }

  async alertCopied({ market, side, outcome, price, size, targetSize, orderId, dryRun }) {
    const tag = dryRun ? " <i>(dry run)</i>" : "";
    await this.send(
`${side==="BUY"?"🟢":"🔴"} <b>Trade copied${tag}</b>

📊 ${escHtml(market)}
🎯 <b>${side} ${outcome}</b> @ ${(price*100).toFixed(1)}%
💵 Your bet: <b>$${size.toFixed(2)}</b>  (target: $${targetSize.toFixed(2)})
🔖 Order: <code>${orderId ?? "—"}</code>`);
  }

  async alertSkipped({ market, side, outcome, price, reason }) {
    if (new Set(["sell_order","too_small"]).has(reason)) return;
    await this.send(
`⏭ <b>Trade skipped</b>

📊 ${escHtml(market ?? "Unknown market")}
🎯 ${side ?? "?"} ${outcome ?? ""} @ ${price ? (price*100).toFixed(1)+"%" : "?"}
❌ Reason: <code>${reason}</code>`);
  }

  async alertDailyCap({ dailyLoss, dailyCap, tradeCount }) {
    await this.send(
`🛑 <b>Daily cap hit — bot paused</b>

💸 Exposure: <b>$${dailyLoss.toFixed(2)}</b> / $${dailyCap}
📈 Trades: ${tradeCount}

Resumes automatically tomorrow.`);
  }

  /** NEW — stop-loss alert */
  async alertStopLoss({ reason, pnl, peak, type }) {
    const peakLine = peak != null ? `\n📈 Peak P&L was: <b>$${peak.toFixed(2)}</b>` : "";
    await this.send(
`🚨 <b>Stop-loss triggered — bot paused</b>

Type: <b>${type}</b>
💸 Current P&L: <b>${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</b>${peakLine}
📝 ${escHtml(reason)}

Bot will resume automatically tomorrow.`);
  }

  async alertWalletFilter({ reason, profit, winRate, tradeCount }) {
    await this.send(
`⚠️ <b>Wallet filter: copying paused</b>

${escHtml(reason)}
📊 P&L: $${profit?.toFixed(2)??"?"}  |  Win: ${winRate!=null?(winRate*100).toFixed(1)+"%":"?"}  |  Trades: ${tradeCount??""}`);
  }

  async alertError({ market, error }) {
    await this.send(`❌ <b>Order failed</b>\n\n📊 ${escHtml(market??"Unknown")}\n🔴 ${escHtml(error)}`);
  }

  async alertDailySummary({ tradeCount, dailyLoss, dailyCap, remaining, realizedPnl, peakPnl }) {
    const pnlLine = realizedPnl != null
      ? `\n💰 Realized P&L: <b>${realizedPnl>=0?"+":""}$${realizedPnl.toFixed(2)}</b>`
      : "";
    const peakLine = peakPnl > 0 ? `\n📈 Peak P&L: <b>$${peakPnl.toFixed(2)}</b>` : "";
    await this.send(
`📋 <b>Daily summary</b>

📈 Trades copied: <b>${tradeCount}</b>
💸 Exposure: <b>$${dailyLoss.toFixed(2)}</b> / $${dailyCap}
✅ Remaining: <b>$${remaining.toFixed(2)}</b>${pnlLine}${peakLine}`);
  }
}

function shortAddr(a) { return a ? a.slice(0,6)+"…"+a.slice(-4) : "?"; }
function escHtml(s)   { return (s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
