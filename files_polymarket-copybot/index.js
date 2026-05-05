#!/usr/bin/env node
/**
 * Polymarket CopyTrade Bot v2
 * Target: 0xFE813EE6c5832DE3b7112EEaf0771F65C7A8ee18
 * Max bet: $5 | Ratio: 50% | Stop-loss: $50 | Trailing: $10
 */

import axios  from "axios";
import chalk  from "chalk";
import dotenv from "dotenv";
import { TelegramNotifier } from "./telegram.js";
import { RiskManager }      from "./riskManager.js";
import { TradeLogger }      from "./logger.js";

dotenv.config();

// ─────────────────────────────────────────────
//  CONFIG — ค่าที่กำหนด
// ─────────────────────────────────────────────
const TARGET_WALLET  = "0xFE813EE6c5832DE3b7112EEaf0771F65C7A8ee18";
const DATA_API       = "https://data-api.polymarket.com";
const GAMMA_API      = "https://gamma-api.polymarket.com";

const POLL_INTERVAL  = parseInt(process.env.POLL_INTERVAL_MS  ?? "8000");
const MAX_BET_USDC   = parseFloat(process.env.MAX_BET_USDC    ?? "5");      // $5
const COPY_RATIO     = parseFloat(process.env.COPY_RATIO      ?? "0.5");    // 50%
const MIN_ODDS       = parseFloat(process.env.MIN_ODDS        ?? "0.10");
const MAX_ODDS       = parseFloat(process.env.MAX_ODDS        ?? "0.90");
const DAILY_LOSS_CAP = parseFloat(process.env.DAILY_LOSS_CAP  ?? "50");     // $50
const DRY_RUN        = process.env.DRY_RUN !== "false";

const STOP_LOSS_USD     = parseFloat(process.env.STOP_LOSS_USD     ?? "50");  // $50
const STOP_LOSS_PCT     = parseFloat(process.env.STOP_LOSS_PCT     ?? "0.10");
const TRAILING_STOP_USD = parseFloat(process.env.TRAILING_STOP_USD ?? "10");  // $10
const STARTING_BALANCE  = parseFloat(process.env.STARTING_BALANCE  ?? "500");

// ─────────────────────────────────────────────
//  BOOTSTRAP
// ─────────────────────────────────────────────
async function bootstrap() {
  console.log(chalk.cyan("\n╔══════════════════════════════════════════╗"));
  console.log(chalk.cyan("║   🤖  POLYMARKET COPYBOT v2 STARTING     ║"));
  console.log(chalk.cyan("╚══════════════════════════════════════════╝\n"));
  console.log(chalk.gray(`   Target    : ${TARGET_WALLET}`));
  console.log(chalk.gray(`   Max bet   : $${MAX_BET_USDC}  |  Ratio: ${COPY_RATIO*100}%`));
  console.log(chalk.gray(`   Stop-loss : $${STOP_LOSS_USD}  |  Trailing: $${TRAILING_STOP_USD}`));
  console.log(chalk.gray(`   Daily cap : $${DAILY_LOSS_CAP}`));
  console.log(chalk.yellow(`   Mode      : ${DRY_RUN ? "🔵 DRY RUN (ไม่มีการเทรดจริง)" : "🔴 LIVE TRADING"}\n`));

  const tg = new TelegramNotifier({
    token  : process.env.TELEGRAM_BOT_TOKEN,
    chatId : process.env.TELEGRAM_CHAT_ID,
    silent : process.env.TELEGRAM_SILENT === "true",
  });

  const risk = new RiskManager({
    dailyCap        : DAILY_LOSS_CAP,
    stopLossUsd     : STOP_LOSS_USD,
    stopLossPct     : STOP_LOSS_PCT,
    trailingStopUsd : TRAILING_STOP_USD,
    startingBalance : STARTING_BALANCE,
    tg,
  });

  const logger = new TradeLogger(tg);

  await tg.alertStartup({
    yourWallet      : "0xFE813EE6c5832DE3b7112EEaf0771F65C7A8ee18",
    targetWallet    : TARGET_WALLET,
    dryRun          : DRY_RUN,
    maxBet          : MAX_BET_USDC,
    copyRatio       : COPY_RATIO,
    dailyCap        : DAILY_LOSS_CAP,
    stopLossUsd     : STOP_LOSS_USD,
    stopLossPct     : STOP_LOSS_PCT,
    trailingStopUsd : TRAILING_STOP_USD,
  });

  await runBot(risk, logger, tg);
}

// ─────────────────────────────────────────────
//  BOT LOOP
// ─────────────────────────────────────────────
const seenIds = new Set();

async function runBot(risk, logger, tg) {
  console.log(chalk.green("👁  กำลังจับตา trades...\n"));

  try {
    const old = await fetchTrades(50);
    old.forEach(t => seenIds.add(t.id));
    console.log(chalk.gray(`   Seeded ${seenIds.size} trades เดิม (จะไม่ copy)\n`));
  } catch {}

  while (true) {
    try {
      if (risk.isKilled()) {
        console.log(chalk.red("🛑  Stop-loss/Daily cap hit — รอถึงพรุ่งนี้"));
        await sleep(POLL_INTERVAL);
        continue;
      }

      const trades = await fetchTrades(20);
      for (const trade of trades) {
        if (seenIds.has(trade.id)) continue;
        seenIds.add(trade.id);
        await processTrade(trade, risk, logger, tg);
      }

    } catch (err) {
      console.error(chalk.red("⚠️  Error:"), err.message);
    }
    await sleep(POLL_INTERVAL);
  }
}

// ─────────────────────────────────────────────
//  FETCH TRADES
// ─────────────────────────────────────────────
async function fetchTrades(limit = 20) {
  const { data } = await axios.get(`${DATA_API}/activity`, {
    params  : { user: TARGET_WALLET, limit },
    timeout : 10_000,
  });
  return data ?? [];
}

// ─────────────────────────────────────────────
//  PROCESS TRADE
// ─────────────────────────────────────────────
async function processTrade(trade, risk, logger, tg) {
  const priceNum = parseFloat(trade.price ?? 0);
  const sizeNum  = parseFloat(trade.size  ?? 0) / 1e6;

  console.log(chalk.blue(`\n📡  Trade ใหม่ detected!`));

  if (priceNum < MIN_ODDS || priceNum > MAX_ODDS) {
    console.log(chalk.gray(`   ⏭  ข้าม — odds ${(priceNum*100).toFixed(1)}% นอกช่วง`));
    await logger.skip(trade, "odds_filter");
    return;
  }

  if (trade.side !== "BUY") {
    console.log(chalk.gray(`   ⏭  ข้าม — SELL order`));
    await logger.skip(trade, "sell_order");
    return;
  }

  const copySize    = Math.min(sizeNum * COPY_RATIO, MAX_BET_USDC);
  const roundedSize = Math.round(copySize * 100) / 100;

  if (roundedSize < 1) {
    console.log(chalk.gray(`   ⏭  ข้าม — ขนาด $${roundedSize} เล็กเกิน`));
    await logger.skip(trade, "too_small");
    return;
  }

  // ดึงข้อมูลตลาด
  let market = { question: "Unknown market", active: true };
  try {
    const { data } = await axios.get(`${GAMMA_API}/markets`, {
      params: { condition_id: trade.market }, timeout: 8_000,
    });
    const m = Array.isArray(data) ? data[0] : data;
    if (m) market = { question: m.question ?? "Unknown", active: m.active ?? true };
  } catch {}

  if (!market.active) {
    console.log(chalk.gray(`   ⏭  ข้าม — ตลาดปิดแล้ว`));
    await logger.skip(trade, "market_closed");
    return;
  }

  console.log(chalk.white(`   📊  ${market.question}`));
  console.log(chalk.white(`   🎯  ${trade.side} ${trade.outcome ?? ""} @ ${(priceNum*100).toFixed(1)}%`));
  console.log(chalk.white(`   💵  Bet: $${roundedSize}  (target: $${sizeNum.toFixed(2)})`));

  if (DRY_RUN) {
    console.log(chalk.yellow(`   🔵  [DRY RUN] Would place $${roundedSize}`));
    await logger.dryRun(trade, roundedSize, priceNum, market);
  } else {
    console.log(chalk.green(`   ✅  [LIVE] Copied $${roundedSize}`));
    await logger.copied(trade, { orderID: "order-" + Date.now() }, roundedSize, priceNum, market, false);
    await risk.recordTrade(roundedSize, priceNum);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

bootstrap().catch(err => {
  console.error(chalk.red("Fatal:"), err.message);
  process.exit(1);
});
