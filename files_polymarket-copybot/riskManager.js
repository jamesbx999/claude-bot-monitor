/**
 * RiskManager — daily cap + stop-loss อัตโนมัติ
 *
 * Stop-loss มี 3 ระดับ:
 *  1. STOP_LOSS_USD      — หยุดทั้งวันถ้าขาดทุนเกิน X ดอลลาร์ (เช่น $50)
 *  2. STOP_LOSS_PCT      — หยุดถ้าขาดทุนเกิน X% ของ starting balance (เช่น 10%)
 *  3. TRAILING_STOP_USD  — หยุดถ้า P&L ร่วงลงจากจุดสูงสุดเกิน X ดอลลาร์ (trailing)
 */
export class RiskManager {
  constructor({ dailyCap, stopLossUsd, stopLossPct, trailingStopUsd, startingBalance, tg = null }) {
    this.dailyCap        = dailyCap;
    this.stopLossUsd     = stopLossUsd     ?? 0;   // 0 = disabled
    this.stopLossPct     = stopLossPct     ?? 0;   // 0 = disabled
    this.trailingStopUsd = trailingStopUsd ?? 0;   // 0 = disabled
    this.startingBalance = startingBalance ?? 0;

    this.dailyLoss       = 0;
    this.realizedPnl     = 0;    // tracks actual wins/losses (updated when trades resolve)
    this.peakPnl         = 0;    // highest P&L reached — for trailing stop
    this.killed          = false;
    this.killReason      = null;
    this.tradeCount      = 0;
    this.dayStart        = this._today();
    this.tg              = tg;
  }

  _today() { return new Date().toDateString(); }

  _resetIfNewDay() {
    if (this._today() !== this.dayStart) {
      this.dailyLoss   = 0;
      this.realizedPnl = 0;
      this.peakPnl     = 0;
      this.killed      = false;
      this.killReason  = null;
      this.tradeCount  = 0;
      this.dayStart    = this._today();
    }
  }

  /**
   * Call after every copied trade.
   * @param {number} size       — USDC bet size
   * @param {number} price      — implied probability (0–1)
   * @param {number|null} pnl   — actual P&L if known (positive = win, negative = loss)
   */
  async recordTrade(size, price, pnl = null) {
    this._resetIfNewDay();
    this.tradeCount++;
    this.dailyLoss += size;   // worst-case exposure

    if (pnl !== null) {
      this.realizedPnl += pnl;
      if (this.realizedPnl > this.peakPnl) {
        this.peakPnl = this.realizedPnl;
      }
    }

    await this._checkAllTriggers();
  }

  /**
   * Call this periodically (e.g. every poll cycle) to update P&L
   * from open positions even without new trades.
   */
  async updatePnl(currentPnl) {
    this._resetIfNewDay();
    this.realizedPnl = currentPnl;
    if (currentPnl > this.peakPnl) this.peakPnl = currentPnl;
    await this._checkAllTriggers();
  }

  async _checkAllTriggers() {
    if (this.killed) return;

    // 1. Daily exposure cap
    if (this.dailyCap > 0 && this.dailyLoss >= this.dailyCap) {
      await this._kill("daily_cap",
        `Daily exposure cap hit ($${this.dailyLoss.toFixed(2)} / $${this.dailyCap})`);
      return;
    }

    // 2. Fixed stop-loss in USD
    if (this.stopLossUsd > 0 && this.realizedPnl <= -this.stopLossUsd) {
      await this._kill("stop_loss_usd",
        `Stop-loss triggered — loss $${Math.abs(this.realizedPnl).toFixed(2)} >= $${this.stopLossUsd}`);
      return;
    }

    // 3. Percentage stop-loss (relative to starting balance)
    if (this.stopLossPct > 0 && this.startingBalance > 0) {
      const threshold = this.startingBalance * this.stopLossPct;
      if (this.realizedPnl <= -threshold) {
        await this._kill("stop_loss_pct",
          `Stop-loss % triggered — loss $${Math.abs(this.realizedPnl).toFixed(2)} >= ${(this.stopLossPct*100).toFixed(0)}% of $${this.startingBalance}`);
        return;
      }
    }

    // 4. Trailing stop
    if (this.trailingStopUsd > 0 && this.peakPnl > 0) {
      const drawdown = this.peakPnl - this.realizedPnl;
      if (drawdown >= this.trailingStopUsd) {
        await this._kill("trailing_stop",
          `Trailing stop triggered — drawdown $${drawdown.toFixed(2)} from peak $${this.peakPnl.toFixed(2)}`);
        return;
      }
    }
  }

  async _kill(reason, message) {
    this.killed     = true;
    this.killReason = reason;
    console.error(`\n🛑  ${message}. Bot paused until tomorrow.\n`);

    const alertMap = {
      daily_cap     : () => this.tg?.alertDailyCap({ dailyLoss: this.dailyLoss, dailyCap: this.dailyCap, tradeCount: this.tradeCount }),
      stop_loss_usd : () => this.tg?.alertStopLoss({ reason: message, pnl: this.realizedPnl, type: "Fixed USD" }),
      stop_loss_pct : () => this.tg?.alertStopLoss({ reason: message, pnl: this.realizedPnl, type: "Percentage" }),
      trailing_stop : () => this.tg?.alertStopLoss({ reason: message, pnl: this.realizedPnl, peak: this.peakPnl, type: "Trailing" }),
    };

    await alertMap[reason]?.().catch(() => {});
  }

  isKilled() {
    this._resetIfNewDay();
    return this.killed;
  }

  killReason_() { return this.killReason; }

  summary() {
    return {
      dailyLoss   : this.dailyLoss,
      realizedPnl : this.realizedPnl,
      peakPnl     : this.peakPnl,
      tradeCount  : this.tradeCount,
      killed      : this.killed,
      killReason  : this.killReason,
      remaining   : Math.max(0, this.dailyCap - this.dailyLoss),
    };
  }
}
