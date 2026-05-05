/**
 * TradeLogger — writes a local JSON log AND sends Telegram alerts
 * for every decision the bot makes.
 */
import fs   from "fs";
import path from "path";

const LOG_FILE = path.resolve("./trades.log.json");

export class TradeLogger {
  constructor(tg = null) {
    this.tg = tg;   // TelegramNotifier instance (optional)
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "[]");
  }

  _append(entry) {
    const logs = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
    logs.push({ ts: new Date().toISOString(), ...entry });
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
  }

  async copied(trade, order, size, price, market, dryRun = false) {
    this._append({
      event     : dryRun ? "DRY_RUN" : "COPIED",
      tradeId   : trade.id,
      orderId   : order?.orderID,
      status    : order?.status,
      market    : market.question,
      size,
      price,
      targetSize: parseFloat(trade.size) / 1e6,
    });

    await this.tg?.alertCopied({
      market     : market.question,
      side       : trade.side,
      outcome    : trade.outcome,
      price,
      size,
      targetSize : parseFloat(trade.size) / 1e6,
      orderId    : order?.orderID,
      dryRun,
    });
  }

  async dryRun(trade, size, price, market) {
    return this.copied(trade, null, size, price, market, true);
  }

  async skip(trade, reason, market = null) {
    this._append({
      event    : "SKIP",
      tradeId  : trade.id,
      reason,
    });

    await this.tg?.alertSkipped({
      market  : market?.question,
      side    : trade.side,
      outcome : trade.outcome,
      price   : parseFloat(trade.price ?? 0),
      reason,
    });
  }

  async error(trade, err, market = null) {
    this._append({
      event   : "ERROR",
      tradeId : trade.id,
      error   : err.message,
    });

    await this.tg?.alertError({
      market : market?.question,
      error  : err.message,
    });
  }
}
