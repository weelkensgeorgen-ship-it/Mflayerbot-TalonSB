require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const mineflayer = require("mineflayer");
const nbt        = require("prismarine-nbt");
const fs         = require("fs");
const path       = require("path");
const net        = require("net");

// ═══════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════

const COMMAND_CHANNEL_ID = process.env.DISCORD_COMMAND_CHANNEL_ID;
const LOG_CHANNEL_ID     = process.env.DISCORD_LOG_CHANNEL_ID;
const ALERTS_CHANNEL_ID  = process.env.DISCORD_ALERTS_CHANNEL_ID;
const ALERTS_ROLE_ID     = process.env.ALERTS_ROLE_ID;
const MC_HOST            = process.env.MC_HOST  || "play.talonmc.net";
const MC_PORT            = parseInt(process.env.MC_PORT) || 25565;

const PROXY_HOST = process.env.PROXY_HOST || "";
const PROXY_PORT = parseInt(process.env.PROXY_PORT) || 0;
const PROXY_USER = process.env.PROXY_USER || "";
const PROXY_PASS = process.env.PROXY_PASS || "";

const POLL_BASE_DELAY = 10000;
const SKILLS_INTERVAL = 5 * 60 * 1000;
const DATA_FILE       = path.join(__dirname, "data.json");

// ═══════════════════════════════════════════════════════════════
//  COMMAND MAP
// ═══════════════════════════════════════════════════════════════

const COMMAND_MAP = {
  moneytop: "/moneytop",
  baltop:   "/baltop",
  tps:      "/tps",
  online:   "/list",
  staff:    "/onlinestaff",
};

// ═══════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════

let mcBot          = null;
let mcReady        = false;
let commandChannel = null;
let logChannel     = null;
let alertChannel   = null;
let inSkyblock     = false;
let pollLoopActive = false;
let pollPaused     = false;
let reconnectTimer = null;

let islandScanTimeout  = null;
let islandScanInterval = null;
let skillsTopTimeout   = null;
let skillsTopInterval  = null;
let antiAfkInterval1   = null;
let antiAfkInterval2   = null;
let isTopAutoInterval  = null;   // for ?is top co_op [N]

let ChatMessage = null;

// Track the current #1 island name so we can detect changes
let topIslandName = null;

const trackedPlayers   = new Map();
const alertCooldowns   = new Map();
const commandCooldowns = new Map();

const stats = {
  commandsRun: 0,
  alertsSent:  0,
  reconnects:  0,
  startTime:   Date.now(),
};

function clearAllTimers() {
  clearTimeout(islandScanTimeout);
  clearInterval(islandScanInterval);
  clearTimeout(skillsTopTimeout);
  clearInterval(skillsTopInterval);
  clearInterval(antiAfkInterval1);
  clearInterval(antiAfkInterval2);
  clearInterval(isTopAutoInterval);
  isTopAutoInterval = null;
}

// ═══════════════════════════════════════════════════════════════
//  PERSISTENCE
// ═══════════════════════════════════════════════════════════════

function saveData() {
  try {
    const obj = {};
    for (const [name, d] of trackedPlayers.entries()) {
      obj[name] = {
        lastBal:         d.lastBal         ?? 0,
        lastIslandValue: d.lastIslandValue ?? 0,
        addedAt:         d.addedAt,
        source:          d.source,
        depositHistory:  d.depositHistory  ?? [],
      };
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.error("[data] Save failed:", e.message); }
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    for (const [name, d] of Object.entries(obj)) {
      trackedPlayers.set(name, {
        lastBal:         d.lastBal         ?? 0,
        lastIslandValue: d.lastIslandValue ?? 0,
        lastInvsee:      null,
        addedAt:         d.addedAt         ?? Date.now(),
        source:          d.source          ?? "manual",
        isOnline:        null,
        depositHistory:  d.depositHistory  ?? [],
        islandMembers:   [],
      });
    }
    console.log(`[data] Loaded ${trackedPlayers.size} tracked players.`);
  } catch (e) { console.error("[data] Load failed:", e.message); }
}

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════

function strip(text) {
  return String(text ?? "").replace(/§[0-9a-fklmnor]/gi, "").trim();
}

function parseMoney(str) {
  if (!str) return 0;
  const s = String(str).replace(/,/g, "").replace(/\$/g, "").trim().toUpperCase();
  const num = parseFloat(s);
  if (isNaN(num)) return 0;
  if (s.endsWith("T")) return num * 1e12;
  if (s.endsWith("B")) return num * 1e9;
  if (s.endsWith("M")) return num * 1e6;
  if (s.endsWith("K")) return num * 1e3;
  return num || 0;
}

function formatMoney(n) {
  if (!n || n === 0) return "$0";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3)  return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(0)}`;
}

function uptime() {
  const ms = Date.now() - stats.startTime;
  const h  = Math.floor(ms / 3600000);
  const m  = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function jitter()  { return Math.floor(Math.random() * 5000); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function hasCooldown(userId, ms = 3000) {
  const last = commandCooldowns.get(userId);
  if (last && Date.now() - last < ms) return true;
  commandCooldowns.set(userId, Date.now());
  return false;
}

function hourLabel(h) {
  if (h === 0)  return "12am";
  if (h < 12)   return `${h}am`;
  if (h === 12) return "12pm";
  return `${h - 12}pm`;
}

function alertPing() {
  return ALERTS_ROLE_ID ? `<@&${ALERTS_ROLE_ID}>` : "";
}

// ═══════════════════════════════════════════════════════════════
//  PROXY  (Webshare HTTP CONNECT tunnel)
// ═══════════════════════════════════════════════════════════════

function createProxySocket(targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PROXY_PORT, PROXY_HOST, () => {
      const auth = Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString("base64");
      const req  = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        `Proxy-Authorization: Basic ${auth}`,
        "", "",
      ].join("\r\n");
      socket.write(req);
    });
    let buf = "";
    socket.on("data", chunk => {
      buf += chunk.toString();
      if (buf.includes("\r\n\r\n")) {
        if (buf.startsWith("HTTP/1.1 200") || buf.startsWith("HTTP/1.0 200")) {
          resolve(socket);
        } else {
          reject(new Error(`Proxy rejected: ${buf.split("\r\n")[0]}`));
        }
        socket.removeAllListeners("data");
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("Proxy connect timeout")), 10000);
  });
}

// ═══════════════════════════════════════════════════════════════
//  NBT TEXT EXTRACTION
// ═══════════════════════════════════════════════════════════════

function extractTextFromJson(obj) {
  if (obj === null || obj === undefined) return "";
  if (typeof obj === "string" || typeof obj === "number") return String(obj);
  if (obj.type !== undefined && obj.value !== undefined) return extractTextFromJson(obj.value);
  let t = "";
  if (Array.isArray(obj)) return obj.map(extractTextFromJson).join("");
  if (obj.text  !== undefined) t += extractTextFromJson(obj.text);
  if (obj[""]   !== undefined) t += extractTextFromJson(obj[""]);
  if (obj.extra !== undefined) t += extractTextFromJson(obj.extra);
  if (obj.with  !== undefined) t += extractTextFromJson(obj.with);
  return t;
}

function nbtItemName(item) {
  let finalName = "";
  try {
    if (item.customName) {
      const parsed = typeof item.customName === "string" ? JSON.parse(item.customName) : item.customName;
      if (ChatMessage) { try { finalName = new ChatMessage(parsed).toString(); } catch {} }
      if (!finalName) finalName = extractTextFromJson(parsed);
      if (!finalName && typeof item.customName === "string") finalName = item.customName;
    }
  } catch {}

  if (!finalName) {
    try {
      if (item.nbt) {
        const simplified = nbt.simplify(item.nbt);
        const rawName = simplified?.display?.Name;
        if (rawName) {
          if (ChatMessage) {
            try {
              const parsed = typeof rawName === "string" ? JSON.parse(rawName) : rawName;
              finalName = new ChatMessage(parsed).toString();
            } catch {}
          }
          if (!finalName) finalName = extractTextFromJson(rawName);
          if (!finalName) finalName = typeof rawName === "string" ? rawName : JSON.stringify(rawName);
        }
      }
    } catch {}
  }
  return strip(finalName || item.displayName || item.name || "");
}

function nbtItemLore(item) {
  const lines = [];
  if (item.customLore) {
    for (const l of item.customLore) {
      try {
        const parsed = typeof l === "string" ? JSON.parse(l) : l;
        let extracted = "";
        if (ChatMessage) { try { extracted = new ChatMessage(parsed).toString(); } catch {} }
        if (!extracted) extracted = extractTextFromJson(parsed);
        if (!extracted) extracted = typeof l === "string" ? l : JSON.stringify(l);
        const s = strip(extracted);
        if (s) lines.push(s);
      } catch { const s = strip(l); if (s) lines.push(s); }
    }
  }
  try {
    if (item.nbt) {
      const simplified = nbt.simplify(item.nbt);
      const loreArr    = simplified?.display?.Lore;
      if (Array.isArray(loreArr)) {
        for (const l of loreArr) {
          try {
            const parsed = typeof l === "string" ? JSON.parse(l) : l;
            let extracted = "";
            if (ChatMessage) { try { extracted = new ChatMessage(parsed).toString(); } catch {} }
            if (!extracted) extracted = extractTextFromJson(parsed);
            if (!extracted) extracted = typeof l === "string" ? l : JSON.stringify(l);
            const s = strip(extracted);
            if (s) lines.push(s);
          } catch { const s = strip(l); if (s) lines.push(s); }
        }
      }
    }
  } catch {}
  return lines;
}

// ═══════════════════════════════════════════════════════════════
//  WINDOW ITEM PARSER
//
//  Only keeps slots that have BOTH a name AND lore.
//  This filters out decorative filler items (glass panes, barriers,
//  arrows, etc.) which have no lore and carry no useful data.
// ═══════════════════════════════════════════════════════════════

function parseWindowItems(window, requireLore = false) {
  const results = [];
  const limit   = window.inventoryStart ?? window.slots.length;

  for (let i = 0; i < limit; i++) {
    const item = window.slots[i];
    if (!item || item.type === 0 || item.type === -1) continue;

    const name = nbtItemName(item);
    if (!name) continue;

    const lore  = nbtItemLore(item);

    // When requireLore is true (used for /is top), skip items with no lore.
    // Filler decorators (glass panes, barriers, black stained glass) never
    // have lore, so this cleanly removes them without needing to hard-code
    // item type IDs.
    if (requireLore && lore.length === 0) continue;

    const count = item.count ?? 1;

    let skullId = null;
    try {
      const simplified = nbt.simplify(item.nbt);
      skullId = simplified?.SkullOwner?.Id ?? null;
    } catch {}

    results.push({ name, lore, slot: i, count, skullId });
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
//  CAPTURE HELPERS
// ═══════════════════════════════════════════════════════════════

function captureOnlyChat(command, waitMs = 3500) {
  return new Promise(resolve => {
    if (!mcBot || !mcReady) return resolve("(bot not connected)");
    const lines = [];
    let timer;

    const onMsg = (msgStr) => {
      const text = strip(msgStr);
      if (!text) return;
      lines.push(text);
      clearTimeout(timer);
      timer = setTimeout(() => {
        mcBot.removeListener("messagestr", onMsg);
        resolve(lines.join("\n") || "(no output)");
      }, 700);
    };

    mcBot.on("messagestr", onMsg);
    mcBot.chat(command);

    setTimeout(() => {
      mcBot.removeListener("messagestr", onMsg);
      resolve(lines.join("\n") || "(no output)");
    }, waitMs);
  });
}

// GUI capture — waits for window to settle (handles loading-screen replacements)
// Pass requireLore=true for /is top so filler slots are discarded.
function captureGui(command, waitMs = 8000, requireLore = false) {
  return new Promise(resolve => {
    if (!mcBot || !mcReady) return resolve([]);

    let lastWindow  = null;
    let settleTimer = null;

    const finish = () => {
      mcBot.removeListener("windowOpen", onWindowGuarded);
      if (lastWindow) {
        const items = parseWindowItems(lastWindow, requireLore);
        try { mcBot.closeWindow(lastWindow); } catch {}
        console.log(`[gui] ${command} → ${items.length} items (requireLore=${requireLore})`);
        resolve(items);
      } else {
        resolve([]);
      }
    };

    const globalTimer = setTimeout(finish, waitMs);

    const guardedFinish = () => {
      clearTimeout(globalTimer);
      finish();
    };

    const onWindowGuarded = window => {
      lastWindow = window;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(guardedFinish, 900);
    };

    mcBot.on("windowOpen", onWindowGuarded);
    mcBot.chat(command);
  });
}

// Smart capture — races chat vs GUI
function capture(command, waitMs = 6000) {
  return new Promise(resolve => {
    if (!mcBot || !mcReady) return resolve({ type: "chat", text: "(bot not connected)" });

    let done = false;
    const finish = result => { if (!done) { done = true; resolve(result); } };

    const lines = [];
    let chatTimer;
    let lastWindow    = null;
    let guiSettleTimer = null;

    const onMsg = (msgStr) => {
      const text = strip(msgStr);
      if (!text) return;
      lines.push(text);
      clearTimeout(chatTimer);
      chatTimer = setTimeout(() => {
        mcBot.removeListener("messagestr", onMsg);
        mcBot.removeListener("windowOpen", onWindow);
        clearTimeout(guiSettleTimer);
        finish({ type: "chat", text: lines.join("\n") || "(no output)" });
      }, 700);
    };

    const finaliseGui = () => {
      mcBot.removeListener("messagestr", onMsg);
      mcBot.removeListener("windowOpen", onWindow);
      clearTimeout(chatTimer);
      if (lastWindow) {
        const items = parseWindowItems(lastWindow, false);
        try { mcBot.closeWindow(lastWindow); } catch {}
        finish({ type: "gui", items });
      } else {
        finish({ type: "chat", text: lines.join("\n") || "(no output)" });
      }
    };

    const onWindow = window => {
      clearTimeout(chatTimer);
      mcBot.removeListener("messagestr", onMsg);
      lastWindow = window;
      clearTimeout(guiSettleTimer);
      guiSettleTimer = setTimeout(finaliseGui, 900);
    };

    mcBot.on("messagestr", onMsg);
    mcBot.on("windowOpen", onWindow);
    mcBot.chat(command);

    setTimeout(() => {
      mcBot.removeListener("messagestr", onMsg);
      mcBot.removeListener("windowOpen", onWindow);
      clearTimeout(guiSettleTimer);
      if (lastWindow && !done) finaliseGui();
      else finish({ type: "chat", text: lines.join("\n") || "(no output)" });
    }, waitMs);
  });
}

// ═══════════════════════════════════════════════════════════════
//  ISLAND TOP  (NBT GUI parsing with lore-filter enabled)
// ═══════════════════════════════════════════════════════════════

async function fetchIsTop() {
  // requireLore=true so filler GUI items are discarded before parsing
  let items = await captureGui("/is top co_op", 9000, true);
  if (items.length) {
    const parsed = parseIsTopItems(items);
    if (parsed.length) return parsed;
  }

  console.log("[istop] /is top co_op no ranked islands, trying click fallback...");
  items = await captureGuiWithClick("/is top", "co_op", 9000);
  if (items.length) {
    const parsed = parseIsTopItems(items);
    if (parsed.length) return parsed;
  }

  console.log("[istop] fallback trying plain /is top...");
  items = await captureGui("/is top", 8000, true);
  if (!items.length) return null;
  return parseIsTopItems(items);
}

function captureGuiWithClick(command, clickKeyword, waitMs = 10000) {
  return new Promise(resolve => {
    if (!mcBot || !mcReady) return resolve([]);

    const globalTimer = setTimeout(() => {
      mcBot.removeListener("windowOpen", onFirstWindow);
      mcBot.removeListener("windowOpen", onSecondWindow);
      resolve([]);
    }, waitMs);

    const onSecondWindow = window => {
      clearTimeout(globalTimer);
      mcBot.removeListener("windowOpen", onSecondWindow);
      setTimeout(() => {
        // requireLore=true for the result window too
        const items = parseWindowItems(window, true);
        try { mcBot.closeWindow(window); } catch {}
        console.log(`[gui] ${command} (click ${clickKeyword}) → ${items.length} items`);
        resolve(items);
      }, 900);
    };

    const onFirstWindow = window => {
      mcBot.removeListener("windowOpen", onFirstWindow);
      setTimeout(() => {
        const limit = window.inventoryStart ?? window.slots.length;
        let clickSlot = -1;
        for (let i = 0; i < limit; i++) {
          const item = window.slots[i];
          if (!item || item.type === 0 || item.type === -1) continue;
          const name = nbtItemName(item).toLowerCase();
          if (name.includes(clickKeyword.toLowerCase())) { clickSlot = i; break; }
        }

        if (clickSlot === -1) {
          clearTimeout(globalTimer);
          const items = parseWindowItems(window, true);
          try { mcBot.closeWindow(window); } catch {}
          resolve(items);
          return;
        }

        console.log(`[gui] ${command} clicking slot ${clickSlot} ("${clickKeyword}")`);
        mcBot.on("windowOpen", onSecondWindow);
        mcBot.clickWindow(clickSlot, 0, 0);
      }, 800);
    };

    mcBot.on("windowOpen", onFirstWindow);
    mcBot.chat(command);
  });
}

function parseIsTopItems(items) {
  const islands = [];

  for (const item of items) {
    // Must have a rank number at the start of the name
    const rankMatch = item.name.match(/^#?(\d+)[\s.\-]+/);
    if (!rankMatch) continue;

    const rank   = parseInt(rankMatch[1]);
    const isName = item.name.replace(/^#?\d+[\s.\-]+/, "").trim() || "Unknown";

    // ── Island value ───────────────────────────────────────────
    // Scan all lore lines for the value. We prefer an explicit
    // "Island Value:" label but fall back to the first parseable
    // money amount found anywhere in the lore.
    let value = 0;
    for (const l of item.lore) {
      const explicit = l.match(/(?:Island\s+)?Value[:\s]*([\d,.]+\s*[TBMK]?)\$?/i);
      if (explicit) { const v = parseMoney(explicit[1]); if (v > 0) { value = v; break; } }
    }
    if (!value) {
      for (const l of item.lore) {
        const m = l.match(/\$([\d,.]+\s*[TBMK]?)/i) ?? l.match(/([\d,.]+\s*[TBMK])\b/i);
        if (m) { const v = parseMoney(m[1]); if (v > 0) { value = v; break; } }
      }
    }

    // ── Members ────────────────────────────────────────────────
    const members = [];
    let inMembers = false;
    for (const l of item.lore) {
      if (/(?:island\s+)?members?:/i.test(l)) { inMembers = true; continue; }
      if (inMembers) {
        const m = l.match(/^[+\-•\s]*([A-Za-z0-9_]{3,16})\s*(?:\(.*\))?$/);
        if (m && !["Value","Level","Click","Island","Owner","Co","Member","Position"].includes(m[1])) {
          if (!members.includes(m[1])) members.push(m[1]);
        } else if (l.trim() === "" || /^[-=─]+$/.test(l)) {
          inMembers = false;
        }
      }
      const ownerM = l.match(/Owner[:\s]+([A-Za-z0-9_]{3,16})/i);
      if (ownerM && !members.includes(ownerM[1])) members.unshift(ownerM[1]);
    }

    const thumbnail = item.skullId
      ? `https://crafatar.com/avatars/${item.skullId}?overlay`
      : null;

    islands.push({ rank, name: isName, value, members, thumbnail });
  }

  islands.sort((a, b) => a.rank - b.rank);
  return islands;
}

// ═══════════════════════════════════════════════════════════════
//  VOUCHER DETECTION
// ═══════════════════════════════════════════════════════════════

function parseVouchersFromItems(items) {
  const vouchers = [];
  for (const item of items) {
    const m = item.name.match(/^([\d,.]+\s*[TBMK]?)\$\s*\(Voucher\)/i);
    if (!m) continue;
    const amount = parseMoney(m[1]);
    if (amount > 0) vouchers.push({ amount, raw: item.name, count: item.count });
  }
  return vouchers;
}

function isOfflineResponse(text) {
  const lower = text.toLowerCase();
  return ["not online","not found","no player","offline","cannot find","player not found"]
    .some(s => lower.includes(s));
}

// ═══════════════════════════════════════════════════════════════
//  PARSE /is info (chat)
// ═══════════════════════════════════════════════════════════════

function parseIsInfo(raw) {
  const result = { islandName: null, value: 0, level: null, upgradePoints: null, members: [] };
  for (const line of raw.split("\n")) {
    const l  = line.trim();
    const nm = l.match(/^Name:\s*(.+)/i);
    const vm = l.match(/Island Value[:\s]*([\d,.]+\s*[TBMK$]*)/i);
    const lm = l.match(/Island Level[:\s]*(\d+)/i);
    const um = l.match(/Upgrade Points[:\s]*([\d,]+)/i);
    const mm = l.match(/^[-•+]\s*([A-Za-z0-9_]{3,16})\s*\((\w+)\)/);
    if (nm) result.islandName    = nm[1].trim();
    if (vm) result.value         = parseMoney(vm[1]);
    if (lm) result.level         = parseInt(lm[1]);
    if (um) result.upgradePoints = parseInt(um[1].replace(/,/g, ""));
    if (mm) result.members.push({ name: mm[1], role: mm[2] });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
//  PARSE /bal
//  TalonMC format: "<Name>'s Balance: ❙ Crop Coins: X ❙ Money: X"
//  We split on ❙ and look for the "Money:" segment.
// ═══════════════════════════════════════════════════════════════

function parseBal(raw) {
  const segments = raw.split("❙").map(s => s.trim());
  for (const seg of segments) {
    const m = seg.match(/^Money:\s*([\d,.]+\s*[TBMK]?)/i);
    if (m) return parseMoney(m[1]);
  }
  const fallback = raw.match(/Money:\s*([\d,.]+\s*[TBMK]?)/i);
  if (fallback) return parseMoney(fallback[1]);
  return 0;
}

// ═══════════════════════════════════════════════════════════════
//  CHANNEL ROUTING HELPERS
//
//  Rule summary:
//    alertChannel   — all automatic monitoring alerts (vouchers,
//                     balance drops, online/offline, island changes,
//                     skills top changes, morning report, island top scan)
//    commandChannel — bot status messages (online/kicked/reconnecting),
//                     /bal poll results for each tracked player,
//                     proxy failures, hub rejoins
// ═══════════════════════════════════════════════════════════════

async function sendEmbed(title, description, color = 0xf5a623, fields = [], ping = false, targetChannel = null) {
  const ch = targetChannel ?? alertChannel;
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description || "\u200b")
    .setColor(color)
    .setTimestamp();
  if (fields.length) embed.addFields(fields);
  return ch.send({ content: ping ? alertPing() : undefined, embeds: [embed] }).catch(console.error);
}

// Shorthand: send to commandChannel
async function sendToCommand(title, description, color = 0x5865f2, fields = []) {
  return sendEmbed(title, description, color, fields, false, commandChannel);
}

// Shorthand: send to alertChannel (with optional @alerts ping)
async function sendAlert(title, description, color = 0xef4444, fields = [], ping = true) {
  return sendEmbed(title, description, color, fields, ping, alertChannel);
}

// Reply to a Discord command message
async function replyEmbed(msg, title, description, color = 0xf5a623, fields = []) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description || "\u200b")
    .setColor(color)
    .setTimestamp();
  if (fields.length) embed.addFields(fields);
  return msg.reply({ embeds: [embed] }).catch(console.error);
}

async function replyFormatted(msg, title, raw, color = 0x2b2d31) {
  const trimmed = raw.length > 1800 ? raw.slice(0, 1800) + "\n…(truncated)" : raw;
  return replyEmbed(msg, title, `\`\`\`\n${trimmed}\n\`\`\``, color);
}

async function replyGuiContents(msg, command, items) {
  if (!items.length) {
    return replyEmbed(msg, "🖥️ GUI Empty", `Command \`${command}\` returned no items.`, 0xef4444);
  }
  const chunkSize = 25;
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk  = items.slice(i, i + chunkSize);
    const part   = Math.floor(i / chunkSize) + 1;
    const total  = Math.ceil(items.length / chunkSize);
    const fields = chunk.map(it => ({
      name:   `Slot ${it.slot}: ${it.name}${it.count > 1 ? ` ×${it.count}` : ""}`,
      value:  it.lore.length ? `\`\`\`${it.lore.join("\n").slice(0, 900)}\`\`\`` : "*(no lore)*",
      inline: false,
    }));
    const embed = new EmbedBuilder()
      .setTitle(`🖥️ GUI Contents${total > 1 ? ` (${part}/${total})` : ""}`)
      .setDescription(`Command: \`${command}\` — **${items.length}** items found`)
      .setColor(0x5865f2)
      .setTimestamp()
      .addFields(fields);
    await msg.channel.send({ embeds: [embed] }).catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════
//  MORNING REPORT  (8:00am daily → alertChannel)
// ═══════════════════════════════════════════════════════════════

function scheduleMorningReport() {
  const now  = new Date();
  const next = new Date();
  next.setHours(8, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  console.log(`[report] Morning report in ${Math.round((next - now) / 60000)}m`);
  setTimeout(() => {
    sendMorningReport();
    setInterval(sendMorningReport, 24 * 60 * 60 * 1000);
  }, next - now);
}

async function sendMorningReport() {
  if (!trackedPlayers.size) return;
  const since = Date.now() - 8 * 60 * 60 * 1000;
  const rows  = [];
  let biggestDepositor = null, biggestAmt = 0;

  for (const [name, d] of trackedPlayers.entries()) {
    const overnight = (d.depositHistory ?? [])
      .filter(x => x.ts >= since)
      .reduce((s, x) => s + x.amount, 0);
    const onStr  = d.isOnline === true ? "🟢" : d.isOnline === false ? "🔴" : "❓";
    const depStr = overnight > 0 ? `deposited **${formatMoney(overnight)}**` : "no deposits";
    rows.push(`${onStr} **${name}** — island: \`${d.lastIslandValue ? formatMoney(d.lastIslandValue) : "—"}\` | ${depStr}`);
    if (overnight > biggestAmt) { biggestAmt = overnight; biggestDepositor = name; }
  }

  const note = biggestDepositor
    ? `\n\n🏆 Biggest overnight depositor: **${biggestDepositor}** (${formatMoney(biggestAmt)})`
    : "";

  await sendAlert(
    "🌅 Morning Report",
    `Overnight summary for **${trackedPlayers.size}** tracked players:\n\n${rows.join("\n")}${note}`,
    0x5865f2,
    [],
    false // no ping for morning report
  );
}

// ═══════════════════════════════════════════════════════════════
//  SKILLS TOP WATCHER  (→ alertChannel, only on change)
// ═══════════════════════════════════════════════════════════════

const lastSkillsTop = {};

function extractTopThreeNames(raw) {
  const names = [];
  for (const line of raw.split("\n")) {
    const m = line.trim().match(/^(\d+)[.)]\s*([A-Za-z0-9_]{3,16})/);
    if (m) { names.push(m[2]); if (names.length === 3) break; }
  }
  return names.join(", ");
}

async function checkSkillsTop() {
  if (!mcReady || !inSkyblock) return;
  const categories = [
    { key: "overall", cmd: "/skillstop",          label: "Overall Skills Top" },
    { key: "farming", cmd: "/skillstop farming",  label: "Farming Skills Top" },
    { key: "mining",  cmd: "/skillstop mining",   label: "Mining Skills Top"  },
    { key: "fishing", cmd: "/skillstop fishing",  label: "Fishing Skills Top" },
  ];

  for (const cat of categories) {
    await sleep(POLL_BASE_DELAY + jitter());
    if (!mcReady || !inSkyblock) break;
    const output = await captureOnlyChat(cat.cmd, 4000);
    if (!output || output.includes("bot not connected")) continue;

    const names = extractTopThreeNames(output);
    const prev  = lastSkillsTop[cat.key];
    lastSkillsTop[cat.key] = names;

    if (prev === undefined) continue;
    if (prev === names)     continue;

    const trimmed = output.length > 1500 ? output.slice(0, 1500) + "\n…" : output;
    await sendAlert(
      `📊 ${cat.label} — Top 3 Changed!`,
      `\`\`\`\n${trimmed}\n\`\`\``,
      0xf97316,
      [{ name: "⚠️ Change detected", value: `Was: \`${prev || "—"}\`\nNow: \`${names}\`` }],
      false // no ping for skills changes
    );
  }
}

// ═══════════════════════════════════════════════════════════════
//  POLL LOOP
// ═══════════════════════════════════════════════════════════════

async function runPollLoop() {
  if (pollLoopActive) return;
  pollLoopActive = true;
  console.log("[poll] Poll loop started.");

  while (true) {
    if (!mcReady || !inSkyblock || trackedPlayers.size === 0 || pollPaused) {
      await sleep(5000);
      continue;
    }

    const players = [...trackedPlayers.keys()];

    // ── Phase 1: /invsee each player (GUI → alertChannel) ────────
        // ── Phase 1: /invsee each player (GUI → alertChannel) ────────
    for (const player of players) {
      if (!mcReady || !inSkyblock || pollPaused) break;

      let data = trackedPlayers.get(player);
      if (!data) continue;

      // If we already know they're offline, do a lightweight /bal check
      // to detect when they come back rather than opening a GUI.
      if (data.isOnline === false) {
        await sleep(POLL_BASE_DELAY + jitter());
        const probe = await captureOnlyChat(`/bal ${player}`, 4000);
        if (!isOfflineResponse(probe) && parseBal(probe) > 0) {
          data.isOnline = true;
          trackedPlayers.set(player, data);
          await sendAlert("🟢 Player Online", `**${player}** came back online!`, 0x22c55e, [], false);
        }
        continue;
      }

      await sleep(POLL_BASE_DELAY + jitter());

      const result = await capture(`/invsee ${player}`, 5000);
      data = trackedPlayers.get(player);
      if (!data) continue;

      if (result.type === "chat") {
        // Chat response = offline/error — route to alertChannel
        const offline = isOfflineResponse(result.text);
        if (offline && data.isOnline === true) {
          data.isOnline = false;
          await sendAlert("🔴 Player Offline", `**${player}** has gone offline.`, 0x888780, [], false);
        } else if (!offline && data.isOnline === false) {
          data.isOnline = true;
          await sendAlert("🟢 Player Online", `**${player}** came back online!`, 0x22c55e, [], false);
        } else if (data.isOnline === null) {
          data.isOnline = !offline;
        }
      } else {
        // GUI = online
        if (data.isOnline === false) {
          await sendAlert("🟢 Player Online", `**${player}** came back online!`, 0x22c55e, [], false);
        }
        data.isOnline = true;

        const vouchers = parseVouchersFromItems(result.items);
        const hadTotal = data.lastInvsee?.voucherTotal ?? 0;
        const nowTotal = vouchers.reduce((s, v) => s + v.amount * v.count, 0);

        data.lastInvsee = { voucherTotal: nowTotal, vouchers, ts: Date.now() };

        if (nowTotal > 0 && nowTotal !== hadTotal) {
          const key       = `invsee_${player}`;
          const lastAlert = alertCooldowns.get(key) || 0;
          if (Date.now() - lastAlert > 120000) {
            alertCooldowns.set(key, Date.now());
            stats.alertsSent++;
            const list = vouchers.map(v =>
              `• ${formatMoney(v.amount)}${v.count > 1 ? ` ×${v.count} = ${formatMoney(v.amount * v.count)}` : ""} — \`${v.raw}\``
            ).join("\n");
            await sendAlert(
              "💵 VOUCHER DETECTED",
              `**${player}** is holding money vouchers!`,
              0xf97316,
              [
                { name: "Vouchers Found", value: list,                  inline: false },
                { name: "Total Value",    value: formatMoney(nowTotal), inline: true  },
                { name: "Change",         value: hadTotal > 0
                    ? `${formatMoney(hadTotal)} → ${formatMoney(nowTotal)}`
                    : "Newly detected",                                  inline: true  },
              ],
              true // ping @alerts
            );
          }
        }
      }

      trackedPlayers.set(player, data);
      console.log(`[poll] invsee ${player}: ${data.isOnline ? "online" : "offline"}`);
    }

    // ── Phase 2: /bal each player (→ commandChannel) ─────────────
    //
    // Balance results are informational/noisy so they go to
    // commandChannel. Only DROPS trigger alerts in alertChannel.
    // Skip players known to be offline — resume when they come back.
    for (const player of players) {
      if (!mcReady || !inSkyblock || pollPaused) break;

      const data = trackedPlayers.get(player);
      if (!data) continue;

      // Skip bal check for players we know are offline
      if (data.isOnline === false) continue;

      await sleep(POLL_BASE_DELAY + jitter());

      const output  = await captureOnlyChat(`/bal ${player}`, 4000);

      const current  = parseBal(output);
      const previous = data.lastBal ?? 0;
      if (current > 0) data.lastBal = current;
      trackedPlayers.set(player, data);

      // Forward the raw /bal result to commandChannel so you can see it
      if (current > 0) {
        const increased = previous > 0 && current > previous;
        const changeStr = previous > 0
          ? `\nPrevious: \`${formatMoney(previous)}\`` + (increased ? `  🟢 +${formatMoney(current - previous)}` : "")
          : "";
        sendToCommand(
          `💰 /bal ${player}`,
          `Current balance: **${formatMoney(current)}**${changeStr}`,
          increased ? 0x22c55e : 0x2b2d31
        );
      }

      // Balance drop alert → alertChannel with @alerts ping
      if (current > 0 && previous > 0 && previous > current) {
        const dropped = previous - current;
        const pct     = dropped / previous;
        // Only alert if drop is ≥10% of previous balance (avoids noise from tiny fluctuations)
        if (pct >= 0.10) {
          const key = `bal_${player}`;
          if (Date.now() - (alertCooldowns.get(key) || 0) > 60000) {
            alertCooldowns.set(key, Date.now());
            stats.alertsSent++;
            data.depositHistory = data.depositHistory ?? [];
            data.depositHistory.push({ ts: Date.now(), amount: dropped });
            if (data.depositHistory.length > 500) data.depositHistory.shift();
            trackedPlayers.set(player, data);
            saveData();
            await sendAlert(
              "🚨 BALANCE DROP",
              `**${player}** just deposited or spent money!`,
              0xef4444,
              [
                { name: "Before",  value: formatMoney(previous),         inline: true },
                { name: "After",   value: formatMoney(current),          inline: true },
                { name: "Dropped", value: `**${formatMoney(dropped)}**`, inline: true },
              ],
              true // ping @alerts
            );
          }
        }
      }
      console.log(`[poll] bal ${player}: ${formatMoney(current)}`);
    }

    // ── Phase 3: /is info each player (hourly → alertChannel) ────
    const isInfoKey  = "isinfo_cycle";
    const lastIsInfo = alertCooldowns.get(isInfoKey) || 0;
    if (Date.now() - lastIsInfo > 60 * 60 * 1000) {
      alertCooldowns.set(isInfoKey, Date.now());

      for (const player of players) {
        if (!mcReady || !inSkyblock || pollPaused) break;
        await sleep(POLL_BASE_DELAY + jitter());

        const output = await captureOnlyChat(`/is info ${player}`, 5000);
        const data   = trackedPlayers.get(player);
        if (!data) continue;

        const parsed  = parseIsInfo(output);
        if (!parsed.value) continue;

        const prevVal = data.lastIslandValue ?? 0;
        data.lastIslandValue = parsed.value;
        if (parsed.members.length) data.islandMembers = parsed.members.map(m => m.name);
        trackedPlayers.set(player, data);
        saveData();

        if (prevVal > 0 && parsed.value > prevVal) {
          const gained    = parsed.value - prevVal;
          const key       = `isval_${player}`;
          const lastAlert = alertCooldowns.get(key) || 0;
          if (Date.now() - lastAlert > 3600000) {
            alertCooldowns.set(key, Date.now());
            stats.alertsSent++;
            await sendAlert(
              "🏝️ ISLAND VALUE INCREASE",
              `**${player}**'s island gained value!`,
              0x3b82f6,
              [
                { name: "Island", value: parsed.islandName ?? "Unknown", inline: true },
                { name: "Before", value: formatMoney(prevVal),           inline: true },
                { name: "After",  value: formatMoney(parsed.value),      inline: true },
                { name: "Gained", value: `**+${formatMoney(gained)}**`,  inline: true },
                { name: "Level",  value: `${parsed.level ?? "—"}`,       inline: true },
              ],
              true
            );
          }
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  ISLAND TOP SCAN  (hourly → alertChannel)
//
//  Also detects when the #1 island name changes (by island name,
//  not by member list) and fires an alert.
// ═══════════════════════════════════════════════════════════════

async function scanIslandTop() {
  if (!mcReady || !inSkyblock) return;
  console.log("[scanner] Fetching /is top GUI...");

  const islands = await fetchIsTop();
  if (!islands || !islands.length) {
    console.log("[scanner] No islands parsed from GUI.");
    return;
  }

  // ── #1 island change detection (by name) ─────────────────────
  const newTopName = islands[0]?.name ?? null;
  if (newTopName && topIslandName !== null && topIslandName !== newTopName) {
    // The #1 island has changed — fire an alert
    const newIsland = islands[0];
    stats.alertsSent++;
    await sendAlert(
      "👑 NEW #1 ISLAND",
      `The top island has changed!`,
      0xf5c400,
      [
        { name: "Was",     value: `\`${topIslandName}\``,                              inline: true },
        { name: "Now",     value: `\`${newTopName}\``,                                 inline: true },
        { name: "Value",   value: newIsland.value ? formatMoney(newIsland.value) : "—", inline: true },
        { name: "Members", value: newIsland.members.join(", ") || "—",                 inline: false },
      ],
      true // ping @alerts
    );
  }
  // Update stored name (even on first run, so next scan has a baseline)
  topIslandName = newTopName;

  // ── Auto-add new players ──────────────────────────────────────
  const added = [];
  for (const island of islands) {
    for (const member of island.members) {
      if (!trackedPlayers.has(member)) {
        trackedPlayers.set(member, {
          lastBal: 0, lastIslandValue: island.value ?? 0, lastInvsee: null,
          addedAt:  Date.now(),
          source:   island.rank === 1 ? "forced-#1" : "autoscan",
          isOnline: null, depositHistory: [], islandMembers: [],
        });
        added.push({ name: member, rank: island.rank });
      }
    }
  }

  // Force-track #1 owner
  if (islands[0]?.rank === 1 && islands[0].members.length) {
    const owner = islands[0].members[0];
    if (!trackedPlayers.has(owner)) {
      trackedPlayers.set(owner, {
        lastBal: 0, lastIslandValue: islands[0].value ?? 0, lastInvsee: null,
        addedAt: Date.now(), source: "forced-#1",
        isOnline: null, depositHistory: [], islandMembers: [],
      });
      if (!added.find(f => f.name === owner)) added.push({ name: owner, rank: 1 });
    }
  }

  if (added.length) {
    saveData();
    const rows = added.map(f => `\`${f.name}\` (island #${f.rank})`).join(", ");
    await sendAlert("🗺️ Auto-Track Update", `Added **${added.length}** new players:\n${rows}`, 0x3b82f6, [], false);
  }

  // ── Post leaderboard embeds → alertChannel ────────────────────
  for (const isl of islands.slice(0, 5)) {
    const embed = new EmbedBuilder()
      .setTitle(`#${isl.rank} — ${isl.name}`)
      .setDescription(`**Rank:** \`#${isl.rank}\``)
      .setColor(0x343a40)
      .setTimestamp();

    if (isl.thumbnail) embed.setThumbnail(isl.thumbnail);

    embed.addFields({
      name:   " ",
      value:  "```ini\n" + `VALUE    = ${isl.value ? formatMoney(isl.value) : "N/A"}` + "\n```",
      inline: false,
    });

    if (isl.members.length) {
      embed.addFields({
        name:   " ",
        value:  "```diff\n" + isl.members.map(m => `+ ${m}`).join("\n") + "\n```",
        inline: false,
      });
    }

    await alertChannel?.send({ embeds: [embed] }).catch(console.error);
  }
}

// ═══════════════════════════════════════════════════════════════
//  RECONNECT HELPER
// ═══════════════════════════════════════════════════════════════

function scheduleReconnect(delay = 30000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; createMcBot(); }, delay);
}

// ═══════════════════════════════════════════════════════════════
//  MINECRAFT BOT
// ═══════════════════════════════════════════════════════════════

async function createMcBot() {
  console.log("[mc] Connecting...");

  if (mcBot) {
    try { mcBot.removeAllListeners(); } catch {}
    try { mcBot.quit(); } catch {}
    mcBot = null;
  }
  clearAllTimers();
  inSkyblock = false;
  mcReady    = false;

  const botOptions = {
    host:     MC_HOST,
    port:     MC_PORT,
    username: process.env.MC_EMAIL,
    auth:     "microsoft",
   // version:  false,
  };

  if (PROXY_HOST && PROXY_PORT) {
    try {
      console.log(`[proxy] Connecting via ${PROXY_HOST}:${PROXY_PORT}...`);
      botOptions.stream = await createProxySocket(MC_HOST, MC_PORT);
      console.log("[proxy] Tunnel established.");
    } catch (err) {
      console.error("[proxy] Failed:", err.message);
      // Proxy failures → commandChannel (operational, not an alert)
      sendToCommand("⚠️ Proxy Failed", `${err.message}\nFalling back to direct connection.`, 0xf5a623);
    }
  }

  mcBot = mineflayer.createBot(botOptions);
  // Fix for TalonMC's broken skin JSON
mcBot._client.on('player_info', (packet) => {
  if (packet.actions?.includes('add_player')) {
    for (const player of packet.players || []) {
      if (player.properties) {
        for (const prop of player.properties) {
          if (prop.name === 'textures' && prop.value) {
            // Validate JSON – if invalid, replace with dummy
            try {
              JSON.parse(prop.value);
            } catch (e) {
              prop.value = JSON.stringify({ textures: { SKIN: { url: '' } } });
            }
          }
        }
      }
    }
  }
});

  mcBot.once("spawn", () => {
    try {
      ChatMessage = require("prismarine-chat")(mcBot.version);
      console.log(`[mc] prismarine-chat loaded for version ${mcBot.version}`);
    } catch (err) {
      console.warn("[mc] prismarine-chat unavailable:", err.message);
    }

    console.log("[mc] Spawned. Joining Skyblock...");
    setTimeout(() => {
      mcBot.chat("/joinqueue skyblock");
      setTimeout(() => {
        inSkyblock = true;
        mcReady    = true;
        console.log("[mc] In Skyblock. Ready!");

        // Bot-online status → commandChannel
        sendToCommand(
          "✅ Bot Online",
          `Connected to **${MC_HOST}** and joined Skyblock.\nTracking **${trackedPlayers.size}** players.`,
          0x22c55e,
          PROXY_HOST ? [{ name: "Proxy", value: `${PROXY_HOST}:${PROXY_PORT}`, inline: true }] : []
        );

        clearTimeout(islandScanTimeout);
        clearInterval(islandScanInterval);
        clearTimeout(skillsTopTimeout);
        clearInterval(skillsTopInterval);
        clearInterval(antiAfkInterval1);
        clearInterval(antiAfkInterval2);

        antiAfkInterval1 = setInterval(() => { 
          if (mcReady && inSkyblock && mcBot && mcBot.player?.entity) {
            mcBot.swingArm(); 
          }
        }, 55000);  
        antiAfkInterval2 = setInterval(() => {
          if (!mcReady || !inSkyblock || !mcBot) return;
          mcBot.setControlState("jump", true);
          setTimeout(() => mcBot?.setControlState("jump", false), 400);
        }, 180000 + Math.random() * 120000);

        islandScanTimeout = setTimeout(() => {
          scanIslandTop();
          islandScanInterval = setInterval(scanIslandTop, 60 * 60 * 1000);
        }, 20000);

        skillsTopTimeout = setTimeout(() => {
          checkSkillsTop();
          skillsTopInterval = setInterval(checkSkillsTop, SKILLS_INTERVAL);
        }, 35000);

        runPollLoop();
      }, 15000);
    }, 4000);
  });

  // MC → Discord chat bridge → logChannel
  mcBot.on("messagestr", (msgStr) => {
    const text = strip(msgStr);
    if (!text || !logChannel) return;
    logChannel.send(`💬 \`${text}\``).catch(() => {});

    const hubSignals = ["welcome to the hub","returned to hub","server restarting","kicked to hub","sent to hub"];
    if (hubSignals.some(s => text.toLowerCase().includes(s)) && inSkyblock) {
      inSkyblock = false;
      mcReady    = false;
      // Hub rejoin is operational → commandChannel
      sendToCommand("🔄 Sent to Hub", "Rejoining Skyblock in 12s...", 0xf5a623);
      setTimeout(() => {
        if (!mcBot) return;
        mcBot.chat("/joinqueue skyblock");
        setTimeout(() => { inSkyblock = true; mcReady = true; }, 15000);
      }, 12000);
    }
  });

  mcBot.on("kicked", reason => {
    mcReady = false; inSkyblock = false;
    const clean = strip(typeof reason === "string" ? reason : JSON.stringify(reason));
    console.warn("[mc] Kicked:", clean);
    const delay = ["hub","restart","maintenance","lobby"].some(s => clean.toLowerCase().includes(s)) ? 15000 : 30000;
    // Kick is operational → commandChannel
    sendToCommand("⚠️ Bot Kicked", `${clean}\n\nReconnecting in ${delay / 1000}s...`, 0xef4444);
    scheduleReconnect(delay);
    stats.reconnects++;
  });

  mcBot.on("end", () => {
    mcReady = false; inSkyblock = false;
    clearAllTimers();
    console.log("[mc] Disconnected.");
    scheduleReconnect(30000);
    stats.reconnects++;
  });

  mcBot.on("error", err => { console.error("[mc] Error:", err.message); });
}

// ═══════════════════════════════════════════════════════════════
//  DISCORD BOT
// ═══════════════════════════════════════════════════════════════

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

discord.on("messageCreate", async msg => {
  if (msg.author.bot) return;
  if (msg.channel.id !== COMMAND_CHANNEL_ID) return;

  // ── ?<command> ─────────────────────────────────────────────────
  if (msg.content.startsWith("?")) {
    if (!mcReady) return replyEmbed(msg, "❌ Not Connected", "Bot is offline.", 0xef4444);
    if (hasCooldown(msg.author.id, 2000)) return msg.reply("⏱️ Slow down!");

    // ── Special: ?is top co_op [N] ──────────────────────────────
    // Runs /is top co_op immediately then every N minutes.
    // The [N] part is stripped before sending to MC.
    const isTopMatch = msg.content.match(/^\?is\s+top\s+co_op\s*(?:\[(\d+)\])?$/i);
    if (isTopMatch) {
      const intervalMins = isTopMatch[1] ? parseInt(isTopMatch[1]) : null;

      // Clear any previously scheduled auto-istop
      if (isTopAutoInterval) {
        clearInterval(isTopAutoInterval);
        isTopAutoInterval = null;
      }

      const runIsTop = async (replyTarget) => {
        const islands = await fetchIsTop();
        if (!islands?.length) {
          if (replyTarget) replyTarget.channel.send({ embeds: [new EmbedBuilder().setTitle("❌ Island Top Failed").setDescription("Could not read the GUI.").setColor(0xef4444)] }).catch(() => {});
          return;
        }
        for (const isl of islands.slice(0, 5)) {
          const embed = new EmbedBuilder()
            .setTitle(`#${isl.rank} — ${isl.name}`)
            .setDescription(`**Rank:** \`#${isl.rank}\``)
            .setColor(0x343a40)
            .setTimestamp();
          if (isl.thumbnail) embed.setThumbnail(isl.thumbnail);
          embed.addFields({ name: " ", value: "```ini\n" + `VALUE    = ${isl.value ? formatMoney(isl.value) : "N/A"}` + "\n```", inline: false });
          if (isl.members.length) embed.addFields({ name: " ", value: "```diff\n" + isl.members.map(m => `+ ${m}`).join("\n") + "\n```", inline: false });
          await commandChannel?.send({ embeds: [embed] }).catch(() => {});
        }
      };

      await msg.react("⏳").catch(() => {});
      await runIsTop(msg);
      stats.commandsRun++;
      msg.reactions.cache.get("⏳")?.users.remove(discord.user.id).catch(() => {});

      if (intervalMins) {
        const ms = intervalMins * 60 * 1000;
        isTopAutoInterval = setInterval(() => {
          if (!mcReady || !inSkyblock) return;
          runIsTop(null);
        }, ms);
        await replyEmbed(msg, "✅ Island Top Scheduled", `Running \`/is top co_op\` now and every **${intervalMins} minute${intervalMins !== 1 ? "s" : ""}**.\nResults → <#${COMMAND_CHANNEL_ID}>\nUse \`?is top co_op\` (no brackets) to run once and cancel the schedule.`, 0x22c55e);
      }
      return;
    }

    // ── Generic ? passthrough ───────────────────────────────────
    const mcCmd = "/" + msg.content.slice(1).trim();
    await msg.react("⏳").catch(() => {});
    const result = await capture(mcCmd, 5000);
    stats.commandsRun++;
    msg.reactions.cache.get("⏳")?.users.remove(discord.user.id).catch(() => {});
    if (result.type === "gui") return replyGuiContents(msg, mcCmd, result.items);
    return replyFormatted(msg, `📟 ${mcCmd}`, result.text);
  }

  if (!msg.content.startsWith("!")) return;

  const [rawCmd, ...args] = msg.content.slice(1).trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase();

  if (cmd === "help") {
    return replyEmbed(msg, "📖 MFlayerBot — Commands", "\u200b", 0x5865f2, [
      {
        name: "🎮 Minecraft Info",
        value: [
          "`!moneytop` — Money leaderboard",
          "`!baltop` — Balance top",
          "`!istop` — Island top (GUI, NBT parsed)",
          "`!staff` — Online staff",
          "`!online` — Online players",
          "`!tps` — Server TPS",
          "`!skillstop [farming/mining/fishing]` — Skills leaderboard (GUI-aware)",
          "`?<command>` — Run any MC command. GUIs auto-detected.",
          "`?is top co_op [N]` — Run `/is top co_op` now & repeat every N minutes → **#commands**. Omit `[N]` to cancel schedule.",
        ].join("\n"),
      },
      {
        name: "👁️ Tracking",
        value: [
          "`!track <player>` — Track a player (`/invsee` GUI + `/bal` every ~10–15s)",
          "`!untrack <player>` — Stop tracking",
          "`!tracklist` — All tracked players",
          "`!trackinfo <player>` — Detailed player info",
          "`!isinfo <player>` — Island info",
          "`!compare <p1> <p2>` — Side-by-side comparison",
          "`!pattern <player>` — Deposit time pattern analysis",
        ].join("\n"),
      },
      {
        name: "⚙️ Control",
        value: [
          "`!say <msg>` — Send message in Minecraft",
          "`!pause` / `!resume` — Pause/resume poll loop",
          "`!status` — Bot stats",
          "`!reconnect` — Force reconnect",
        ].join("\n"),
      },
      {
        name: "🔔 Channel Routing",
        value: [
          "**Alerts channel:** Vouchers • Balance drops • Online/offline • #1 island change • Island value increase • Skills top change • Morning report • Hourly island scan",
          "**Command channel:** Bot status • `/bal` poll results (🟢 on increase) • Kicks • Hub rejoins • Proxy failures • `?is top co_op` schedule results",
          "**Offline players:** `/invsee` + `/bal` polling paused; resumes automatically when player comes back online.",
        ].join("\n"),
      },
    ]);
  }

  if (cmd === "status") {
    return replyEmbed(msg, "📊 Bot Status", "\u200b", mcReady ? 0x22c55e : 0xef4444, [
      { name: "Minecraft",    value: mcReady    ? "🟢 Connected"     : "🔴 Offline",     inline: true },
      { name: "Skyblock",     value: inSkyblock ? "🟢 Yes"           : "🟡 Hub/Joining", inline: true },
      { name: "Poll Loop",    value: pollPaused ? "⏸️ Paused"        : "▶️ Running",     inline: true },
      { name: "Proxy",        value: PROXY_HOST ? `${PROXY_HOST}:${PROXY_PORT}` : "None", inline: true },
      { name: "Uptime",       value: uptime(),                                            inline: true },
      { name: "Tracked",      value: `${trackedPlayers.size} players`,                   inline: true },
      { name: "Alerts sent",  value: `${stats.alertsSent}`,                              inline: true },
      { name: "Commands run", value: `${stats.commandsRun}`,                             inline: true },
      { name: "Reconnects",   value: `${stats.reconnects}`,                              inline: true },
      { name: "Top Island",   value: topIslandName ? `\`${topIslandName}\`` : "Unknown", inline: true },
    ]);
  }

  if (cmd === "pause")  { pollPaused = true;  return replyEmbed(msg, "⏸️ Paused",  "Use `!resume` to restart.", 0xf5a623); }
  if (cmd === "resume") { pollPaused = false; return replyEmbed(msg, "▶️ Resumed", "Back to monitoring.",       0x22c55e); }

  if (cmd === "reconnect") {
    await replyEmbed(msg, "🔄 Reconnecting", "Forcing Minecraft reconnect...", 0xf5a623);
    mcReady = false; inSkyblock = false;
    if (mcBot) mcBot.quit();
    else scheduleReconnect(2000);
    return;
  }

  if (cmd === "say") {
    if (!mcReady) return replyEmbed(msg, "❌ Not Connected", "Bot is offline.", 0xef4444);
    if (!args.length) return msg.reply("Usage: `!say <message>`");
    const text = args.join(" ");
    mcBot.chat(text);
    return replyEmbed(msg, "💬 Sent to Minecraft", `> ${text}`, 0x22c55e);
  }

  if (cmd === "track") {
    const player = args[0];
    if (!player) return msg.reply("Usage: `!track <playername>`");
    const exists = trackedPlayers.has(player);
    if (!exists) {
      trackedPlayers.set(player, {
        lastBal: 0, lastIslandValue: 0, lastInvsee: null,
        addedAt: Date.now(), source: "manual",
        isOnline: null, depositHistory: [], islandMembers: [],
      });
      saveData();
    }
    if (exists) return replyEmbed(msg, "ℹ️ Already Tracking", `**${player}** is already on the watchlist.`, 0xf5a623);
    return replyEmbed(msg, "✅ Now Tracking", `**${player}** added.\nPolling \`/invsee\` (GUI) + \`/bal\` every ~10–15s.`, 0x22c55e,
      [{ name: "Alerts on", value: "Vouchers • Balance drops • Online/offline" }]);
  }

  if (cmd === "untrack") {
    const player = args[0];
    if (!player) return msg.reply("Usage: `!untrack <playername>`");
    if (!trackedPlayers.has(player)) return replyEmbed(msg, "❌ Not Found", `**${player}** isn't being tracked.`, 0xef4444);
    trackedPlayers.delete(player);
    ["bal","invsee","isval"].forEach(k => alertCooldowns.delete(`${k}_${player}`));
    saveData();
    return replyEmbed(msg, "🗑️ Removed", `Stopped tracking **${player}**.`, 0x888780);
  }

  if (cmd === "tracklist") {
    if (!trackedPlayers.size) return replyEmbed(msg, "👁️ Tracked Players", "None yet. Use `!track <n>`.", 0x888780);
    const rows = [...trackedPlayers.entries()].map(([name, d]) => {
      const bal    = d.lastBal         ? formatMoney(d.lastBal)         : "—";
      const isval  = d.lastIslandValue ? formatMoney(d.lastIslandValue) : "—";
      const paper  = d.lastInvsee?.voucherTotal > 0 ? " 💵" : "";
      const online = d.isOnline === true ? " 🟢" : d.isOnline === false ? " 🔴" : "";
      const src    = d.source === "manual" ? "👤" : "🤖";
      return `${src}${online}${paper} **${name}** — bal: \`${bal}\` | island: \`${isval}\``;
    });
    return replyEmbed(msg, `👁️ Tracked Players (${trackedPlayers.size})`, rows.join("\n"), 0x5865f2);
  }

  if (cmd === "trackinfo") {
    const player = args[0];
    if (!player) return msg.reply("Usage: `!trackinfo <playername>`");
    const d = trackedPlayers.get(player);
    if (!d) return replyEmbed(msg, "❌ Not Found", `**${player}** is not being tracked.`, 0xef4444);
    const vouchStr = d.lastInvsee?.vouchers?.length
      ? d.lastInvsee.vouchers.map(v => `${formatMoney(v.amount)}${v.count > 1 ? ` ×${v.count}` : ""}`).join(", ")
      : "None";
    return replyEmbed(msg, `🔍 ${player}`, "\u200b", 0xf5a623, [
      { name: "Balance",       value: d.lastBal         ? formatMoney(d.lastBal)         : "Unknown", inline: true },
      { name: "Island Value",  value: d.lastIslandValue ? formatMoney(d.lastIslandValue) : "Unknown", inline: true },
      { name: "Status",        value: d.isOnline === true ? "🟢 Online" : d.isOnline === false ? "🔴 Offline" : "❓ Unknown", inline: true },
      { name: "Vouchers",      value: vouchStr,                                                        inline: true },
      { name: "Last Invsee",   value: d.lastInvsee ? new Date(d.lastInvsee.ts).toLocaleTimeString() : "Never", inline: true },
      { name: "Deposits seen", value: `${(d.depositHistory ?? []).length}`,                            inline: true },
      { name: "Added",         value: new Date(d.addedAt).toLocaleString(),                            inline: true },
      { name: "Source",        value: d.source,                                                        inline: true },
    ]);
  }

  if (cmd === "isinfo") {
    const player = args[0];
    if (!player) return msg.reply("Usage: `!isinfo <playername>`");
    if (!mcReady) return replyEmbed(msg, "❌ Not Connected", "\u200b", 0xef4444);
    await msg.react("⏳").catch(() => {});
    const output = await captureOnlyChat(`/is info ${player}`, 5000);
    const parsed = parseIsInfo(output);
    stats.commandsRun++;
    msg.reactions.cache.get("⏳")?.users.remove(discord.user.id).catch(() => {});
    if (!parsed.islandName && !parsed.value) return replyFormatted(msg, `🏝️ Island Info — ${player}`, output);
    return replyEmbed(msg, `🏝️ ${parsed.islandName ?? player}`, "\u200b", 0x3b82f6, [
      { name: "Island Value",   value: formatMoney(parsed.value),        inline: true },
      { name: "Island Level",   value: `${parsed.level ?? "—"}`,         inline: true },
      { name: "Upgrade Points", value: `${parsed.upgradePoints ?? "—"}`, inline: true },
      { name: `Members (${parsed.members.length})`,
        value: parsed.members.length ? parsed.members.map(m => `\`${m.name}\` (${m.role})`).join(", ") : "—",
        inline: false },
    ]);
  }

  if (cmd === "istop") {
    if (!mcReady) return replyEmbed(msg, "❌ Not Connected", "\u200b", 0xef4444);
    if (hasCooldown(msg.author.id, 5000)) return msg.reply("⏱️ Slow down!");
    await msg.react("⏳").catch(() => {});
    const islands = await fetchIsTop();
    stats.commandsRun++;
    msg.reactions.cache.get("⏳")?.users.remove(discord.user.id).catch(() => {});
    if (!islands?.length) return replyEmbed(msg, "❌ Island Top Failed", "Could not read the GUI.", 0xef4444);

    const showCount = args.length ? islands.length : 5;
    for (const isl of islands.slice(0, showCount)) {
      const embed = new EmbedBuilder()
        .setTitle(`#${isl.rank} — ${isl.name}`)
        .setDescription(`**Rank:** \`#${isl.rank}\``)
        .setColor(0x343a40)
        .setFooter({ text: `requested by ${msg.author.username}`, iconURL: msg.author.displayAvatarURL() })
        .setTimestamp();
      if (isl.thumbnail) embed.setThumbnail(isl.thumbnail);
      embed.addFields({
        name:   " ",
        value:  "```ini\n" + `VALUE    = ${isl.value ? formatMoney(isl.value) : "N/A"}` + "\n```",
        inline: false,
      });
      if (isl.members.length) {
        embed.addFields({
          name:   " ",
          value:  "```diff\n" + isl.members.map(m => `+ ${m}`).join("\n") + "\n```",
          inline: false,
        });
      }
      await msg.channel.send({ embeds: [embed] }).catch(() => {});
    }
    return;
  }

  if (cmd === "skillstop") {
    if (!mcReady) return replyEmbed(msg, "❌ Not Connected", "\u200b", 0xef4444);
    if (hasCooldown(msg.author.id, 3000)) return msg.reply("⏱️ Slow down!");
    const cat   = args[0]?.toLowerCase();
    const mcCmd = cat ? `/skillstop ${cat}` : "/skillstop";
    const label = cat ? `${cat.charAt(0).toUpperCase() + cat.slice(1)} Skills Top` : "Overall Skills Top";
    await msg.react("⏳").catch(() => {});
    // Use smart capture — /skillstop may open a GUI ("Leaderboard (Page 1)")
    const result = await capture(mcCmd, 6000);
    stats.commandsRun++;
    msg.reactions.cache.get("⏳")?.users.remove(discord.user.id).catch(() => {});
    if (result.type === "gui") return replyGuiContents(msg, mcCmd, result.items);
    return replyFormatted(msg, `📊 ${label}`, result.text, 0x5865f2);
  }

  if (cmd === "compare") {
    const [p1, p2] = args;
    if (!p1 || !p2) return msg.reply("Usage: `!compare <player1> <player2>`");
    if (!mcReady) return replyEmbed(msg, "❌ Not Connected", "\u200b", 0xef4444);
    await msg.react("⏳").catch(() => {});
    const [out1, out2, b1raw, b2raw] = await Promise.all([
      captureOnlyChat(`/is info ${p1}`, 5000),
      captureOnlyChat(`/is info ${p2}`, 5000),
      captureOnlyChat(`/bal ${p1}`, 4000),
      captureOnlyChat(`/bal ${p2}`, 4000),
    ]);
    const i1 = parseIsInfo(out1), i2 = parseIsInfo(out2);
    const b1 = parseBal(b1raw) || (trackedPlayers.get(p1)?.lastBal ?? 0);
    const b2 = parseBal(b2raw) || (trackedPlayers.get(p2)?.lastBal ?? 0);
    stats.commandsRun++;
    msg.reactions.cache.get("⏳")?.users.remove(discord.user.id).catch(() => {});
    const w = (v1, v2) => v1 > v2 ? "✅" : v1 < v2 ? "❌" : "➖";
    return replyEmbed(msg, `⚔️ ${p1} vs ${p2}`, "\u200b", 0x5865f2, [
      { name: "Stat", value: "Balance\nIsland Value\nIsland Level", inline: true },
      { name: p1, value: `${w(b1,b2)} \`${formatMoney(b1)}\`\n${w(i1.value,i2.value)} \`${formatMoney(i1.value)}\`\n${w(i1.level,i2.level)} \`${i1.level ?? "—"}\``, inline: true },
      { name: p2, value: `${w(b2,b1)} \`${formatMoney(b2)}\`\n${w(i2.value,i1.value)} \`${formatMoney(i2.value)}\`\n${w(i2.level,i1.level)} \`${i2.level ?? "—"}\``, inline: true },
    ]);
  }

  if (cmd === "pattern") {
    const player = args[0];
    if (!player) return msg.reply("Usage: `!pattern <playername>`");
    const d = trackedPlayers.get(player);
    if (!d) return replyEmbed(msg, "❌ Not Tracked", `**${player}** is not being tracked.`, 0xef4444);
    const history = d.depositHistory ?? [];
    if (history.length < 3) return msg.reply(`Not enough data for **${player}** yet (${history.length}/3 needed).`);
    const byHour = Array(24).fill(null).map(() => ({ count: 0, total: 0 }));
    for (const { ts, amount } of history) { const h = new Date(ts).getHours(); byHour[h].count++; byHour[h].total += amount; }
    const ranked = byHour.map((d, h) => ({ h, ...d })).filter(d => d.count > 0).sort((a, b) => b.count - a.count).slice(0, 5);
    const rows   = ranked.map(r => `\`${hourLabel(r.h).padStart(4)}\` — ${r.count} deposit${r.count !== 1 ? "s" : ""}, total: ${formatMoney(r.total)}`);
    const total  = history.reduce((s, d) => s + d.amount, 0);
    return replyEmbed(msg, `📈 Deposit Pattern — ${player}`,
      `Based on **${history.length}** events.\n\n**Most active hours:**\n${rows.join("\n")}\n\n**Total tracked:** ${formatMoney(total)}`,
      0xf5a623);
  }

  if (COMMAND_MAP[cmd] !== undefined) {
    if (!mcReady) return replyEmbed(msg, "❌ Not Connected", "\u200b", 0xef4444);
    if (hasCooldown(msg.author.id)) return msg.reply("⏱️ Slow down!");
    await msg.react("⏳").catch(() => {});
    const result = await captureOnlyChat(COMMAND_MAP[cmd], 4000);
    stats.commandsRun++;
    msg.reactions.cache.get("⏳")?.users.remove(discord.user.id).catch(() => {});
    return replyFormatted(msg, `📊 ${cmd.charAt(0).toUpperCase() + cmd.slice(1)}`, result);
  }

  msg.reply("Unknown command. Type `!help` to see all commands.");
});

discord.once("clientReady", async () => {
  console.log(`[discord] Logged in as ${discord.user.tag}`);
  commandChannel = await discord.channels.fetch(COMMAND_CHANNEL_ID).catch(() => null);
  logChannel     = await discord.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  alertChannel   = await discord.channels.fetch(ALERTS_CHANNEL_ID).catch(() => null);
  if (!commandChannel) console.error("[discord] COMMAND channel not found! Check DISCORD_COMMAND_CHANNEL_ID");
  if (!logChannel)     console.error("[discord] LOG channel not found! Check DISCORD_LOG_CHANNEL_ID");
  if (!alertChannel)   console.error("[discord] ALERTS channel not found! Check DISCORD_ALERTS_CHANNEL_ID");
  loadData();
  scheduleMorningReport();
  createMcBot();
});

discord.login(process.env.DISCORD_TOKEN);
