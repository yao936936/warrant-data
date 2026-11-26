import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, pctChange, toCsv } from "./snapshot-flow.mjs";

test("依標的加總，排除 ETF 與沒價格的", () => {
  const out = aggregate([
    { underCode: "2330", underName: "台積電", netShares: 1000, price: 2 },
    { underCode: "2330", underName: "台積電", netShares: -500, price: 2 },
    { underCode: "0050", underName: "元大台灣50", netShares: 1000, price: 2 },
    { underCode: "8299", underName: "群聯", netShares: 1000, price: 0 },
  ]);
  assert.deepEqual(out, [{ code: "2330", name: "台積電", amount: 0.1 }]);
});

test("漲幅取到小數兩位，缺資料回 null", () => {
  assert.equal(pctChange(110, 100), 10);
  assert.equal(pctChange(110, 0), null);
});

test("CSV 有 BOM、標題、認售認購兩類，逗號會加引號", () => {
  const csv = toCsv({
    date: "2026/11/26",
    put: [{ code: "8299", name: "群聯", amount: -336.6, close: 1630, day1: 9.76, day5: null }],
    call: [{ code: "2330", name: "台,積電", amount: 1683.8, close: 2145, day1: -0.23, day5: 2.14 }],
  });
  assert.ok(csv.startsWith("﻿日期,類型,代號"));
  const lines = csv.trim().split("\n");
  assert.equal(lines[1], "2026/11/26,認售,8299,群聯,-336.6,1630,9.76,");
  assert.equal(lines[2], '2026/11/26,認購,2330,"台,積電",1683.8,2145,-0.23,2.14');
});
