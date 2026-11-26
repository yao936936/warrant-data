// 每天盤後抓「投資人買賣超權證標的」（上市＋上櫃、認購＋認售），存成 JSON。
// 用法：node snapshot-flow.mjs [輸出資料夾] [日期 YYYYMMDD，可省略＝最近交易日]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TWSE = "https://www.twse.com.tw/rwd/zh";
const TPEX = "https://www.tpex.org.tw";
const UA = { "User-Agent": "Mozilla/5.0", Accept: "application/json, text/plain, */*" };

export const num = (s) => {
  const v = Number(
    String(s ?? "")
      .replace(/,/g, "")
      .trim(),
  );
  return Number.isFinite(v) ? v : 0;
};
const slash = (d) => `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
const rocToYmd = (s) => {
  const [y, m, d] = String(s).trim().split("/");
  return `${Number(y) + 1911}${m}${d}`;
};
const bigTable = (j) =>
  (j?.tables ?? []).reduce((a, t) => ((t.data?.length ?? 0) > a.length ? t.data : a), []);

async function get(url, init = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        ...init,
        headers: { ...UA, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) return await r.json();
      console.warn(`HTTP ${r.status} ${url}`);
    } catch (e) {
      console.warn(`失敗 ${url}: ${e}`);
    }
    await new Promise((ok) => setTimeout(ok, 3000 * (i + 1)));
  }
  return null;
}
const tpexPost = (path, params) =>
  get(`${TPEX}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, response: "json" }).toString(),
  });

/** 依標的加總投資人買賣超金額（萬元）；只留 4 碼個股 */
export function aggregate(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!/^[1-9]\d{3}$/.test(r.underCode) || !(r.price > 0) || !r.netShares) continue;
    const hit = map.get(r.underCode) ?? { code: r.underCode, name: r.underName, amount: 0 };
    hit.amount += (r.netShares * r.price) / 10000;
    map.set(r.underCode, hit);
  }
  return [...map.values()];
}
export const pctChange = (close, base) =>
  close > 0 && base > 0 ? Math.round((close / base - 1) * 10000) / 100 : null;

async function tradingDays() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const months = [];
  for (let k = 2; k >= 0; k--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    months.push(d.toISOString().slice(0, 8).replace(/-/g, "") + "01");
  }
  const res = await Promise.all(
    months.map((m) => get(`${TWSE}/afterTrading/FMTQIK?date=${m}&response=json`)),
  );
  return res
    .flatMap((m) => (m?.data ?? []).map((r) => rocToYmd(r[0] ?? "")))
    .filter((d) => /^\d{8}$/.test(d))
    .sort()
    .reverse();
}

/** 上市：T86 自營商買賣超（欄 11）× 權證當日均價 */
async function twseRows(date, kind) {
  const type = kind === "put" ? "0999P" : "0999";
  const [t86, quotes] = await Promise.all([
    get(`${TWSE}/fund/T86?date=${date}&selectType=${type}&response=json`),
    get(`${TWSE}/afterTrading/MI_INDEX?date=${date}&type=${type}&response=json`),
  ]);
  if (t86?.stat !== "OK" || !t86.data?.length) return null;
  const byCode = new Map(bigTable(quotes).map((r) => [(r[1] ?? "").trim(), r]));
  return t86.data.flatMap((r) => {
    const q = byCode.get((r[0] ?? "").trim());
    if (!q) return [];
    const vol = num(q[3]);
    return [
      {
        underCode: (q[17] ?? "").trim(),
        underName: (q[18] ?? "").trim(),
        netShares: -num(r[11]),
        price: vol > 0 ? num(q[5]) / vol : num(q[9]),
      },
    ];
  });
}

/** 上櫃：櫃買三大法人（權證）欄 22 自營商合計 × 權證當日均價 */
async function tpexRows(date, kind, warrantPrices) {
  const [insti, issue] = await Promise.all([
    tpexPost("/www/zh-tw/insti/dailyTrade", { type: "Daily", sect: "WW", date: slash(date) }),
    get(`${TPEX}/openapi/v1/tpex_warrant_issue`),
  ]);
  const want = kind === "put" ? "認售" : "認購";
  const under = new Map(
    (issue ?? [])
      .filter((r) => r.Type === want)
      .map((r) => [r.Code, { code: r.UnderlyingStockCode, name: r.UnderlyingStock }]),
  );
  const table = bigTable(insti);
  const rows = table.flatMap((r) => {
    const code = (r[0] ?? "").trim();
    const u = under.get(code);
    const p = warrantPrices.get(code) ?? 0;
    if (!u?.code || !(p > 0)) return [];
    return [
      {
        underCode: u.code.trim(),
        underName: (u.name ?? "").trim(),
        netShares: -num(r[22]),
        price: p,
      },
    ];
  });
  return { rows, ok: table.length > 0 && under.size > 0 && warrantPrices.size > 0 };
}

/** 上櫃全部證券（含權證）當日行情：回傳 { closes, warrantPrices } */
async function tpexQuotes(date) {
  const j = await tpexPost("/www/zh-tw/afterTrading/otc", { date: slash(date), type: "AL" });
  const t = (j?.tables ?? []).reduce(
    (a, x) => ((x.data?.length ?? 0) > (a.data?.length ?? 0) ? x : a),
    {},
  );
  const f = t.fields ?? [];
  const col = (re, dflt) => {
    const i = f.findIndex((x) => re.test(x));
    return i >= 0 ? i : dflt;
  };
  const cClose = col(/收盤/, 2);
  const cChg = col(/漲跌/, 3);
  const cVol = col(/成交股數/, 7);
  const cAmt = col(/成交金額/, 8);
  const closes = new Map();
  const warrantPrices = new Map();
  for (const r of t.data ?? []) {
    const code = (r[0] ?? "").trim();
    const close = num(r[cClose]);
    if (/^[1-9]\d{3}$/.test(code)) closes.set(code, { close, prev: close - num(r[cChg]) });
    else if (/^7\d{4}[A-Z0-9]?$/.test(code)) {
      const vol = num(r[cVol]);
      warrantPrices.set(code, vol > 0 ? num(r[cAmt]) / vol : close);
    }
  }
  return { closes, warrantPrices, fields: f };
}

async function twseCloses(date) {
  const j = await get(`${TWSE}/afterTrading/MI_INDEX?date=${date}&type=ALLBUT0999&response=json`);
  const out = new Map();
  for (const r of bigTable(j)) {
    const close = num(r[8]);
    const diff = num(r[10]) * ((r[9] ?? "").includes("-") ? -1 : 1);
    out.set((r[0] ?? "").trim(), { close, prev: close - diff });
  }
  return out;
}

export async function snapshot(wantDate) {
  const days = await tradingDays();
  if (!days.length) throw new Error("抓不到交易日");
  const candidates = wantDate ? [wantDate] : days.slice(0, 3);
  let date = "";
  let twsePut = null;
  for (const d of candidates) {
    twsePut = await twseRows(d, "put");
    if (twsePut) {
      date = d;
      break;
    }
  }
  if (!twsePut) throw new Error("證交所三大法人資料還沒出來");
  const base5 = days[days.indexOf(date) + 5];
  const [twseCall, tq, tc, tqBase, tcBase] = await Promise.all([
    twseRows(date, "call"),
    tpexQuotes(date),
    twseCloses(date),
    base5 ? tpexQuotes(base5) : null,
    base5 ? twseCloses(base5) : null,
  ]);
  console.log("櫃買行情欄位:", tq.fields.join("|"), "權證筆數", tq.warrantPrices.size);
  const today = new Map([...tc, ...tq.closes]);
  const before = new Map([...(tcBase ?? []), ...(tqBase?.closes ?? [])]);

  const out = { date: slash(date), generatedAt: new Date().toISOString(), otcOk: true };
  for (const [kind, twse] of [
    ["put", twsePut],
    ["call", twseCall ?? []],
  ]) {
    const tpex = await tpexRows(date, kind, tq.warrantPrices);
    if (!tpex.ok) out.otcOk = false;
    out[kind] = aggregate([...twse, ...tpex.rows])
      .map((i) => {
        const c = today.get(i.code);
        return {
          code: i.code,
          name: i.name,
          amount: Math.round(i.amount * 10) / 10,
          close: c?.close ?? null,
          day1: c ? pctChange(c.close, c.prev) : null,
          day5: c ? pctChange(c.close, before.get(i.code)?.close ?? 0) : null,
        };
      })
      .sort((a, b) => b.amount - a.amount);
  }
  return out;
}

/** 轉成 CSV（開頭加 BOM，Excel 打開中文才不會亂碼） */
export function toCsv(snap) {
  const head = "日期,類型,代號,名稱,投資人買賣超(萬),收盤價,1日漲幅%,5日漲幅%";
  const cell = (v) =>
    v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const lines = [
    ["put", "認售"],
    ["call", "認購"],
  ].flatMap(([k, label]) =>
    snap[k].map((i) =>
      [snap.date, label, i.code, i.name, i.amount, i.close, i.day1, i.day5].map(cell).join(","),
    ),
  );
  return "\uFEFF" + [head, ...lines].join("\n") + "\n";
}

async function main() {
  const dir = process.argv[2] ?? "data";
  const snap = await snapshot(process.argv[3]);
  const day = snap.date.replace(/\//g, "-");
  await mkdir(join(dir, "flow"), { recursive: true });
  await writeFile(join(dir, "flow", `${day}.json`), JSON.stringify(snap));
  await writeFile(join(dir, "flow", `${day}.csv`), toCsv(snap));
  const idxPath = join(dir, "index.json");
  const idx = JSON.parse(await readFile(idxPath, "utf8").catch(() => "[]"));
  const days = [...new Set([day, ...idx])].sort().reverse();
  await writeFile(idxPath, JSON.stringify(days));
  // 補抓舊日期時不要蓋掉最新一天
  if (days[0] === day) await writeFile(join(dir, "latest.json"), JSON.stringify(snap));
  const top = (k) =>
    snap[k]
      .slice(0, 5)
      .map((i) => `${i.code}${i.name} ${i.amount}`)
      .join("、");
  console.log(
    `${snap.date} 上櫃${snap.otcOk ? "有" : "沒"}抓到；認售 ${snap.put.length} 檔，買超前5：${top("put")}`,
  );
  console.log(`認購 ${snap.call.length} 檔，買超前5：${top("call")}`);
  const otc = snap.put.filter((i) => ["8299", "3260", "5274", "6488"].includes(i.code));
  console.log("上櫃抽查:", JSON.stringify(otc));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
