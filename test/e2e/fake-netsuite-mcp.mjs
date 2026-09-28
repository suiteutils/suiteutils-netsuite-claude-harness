#!/usr/bin/env node
// Fake NetSuite AI Connector (stdio MCP) for end-to-end tests of the hooks inside a real
// Claude Code session. Tool names and params mirror the connector; payloads are synthetic.
// Every tools/call is appended to $FAKE_NS_LOG so tests can see what the connector received.
import * as fs from "node:fs";
import * as readline from "node:readline";

const LOG = process.env.FAKE_NS_LOG;
const log = (o) => LOG && fs.appendFileSync(LOG, JSON.stringify(o) + "\n");

const str = (desc) => ({ type: "string", description: desc });
const num = (desc) => ({ type: "number", description: desc });
const TOOLS = [
  { name: "ns_runCustomSuiteQL", description: "Run a SuiteQL query", inputSchema: { type: "object", properties: { sqlQuery: str("SuiteQL"), description: str("purpose"), pageSize: num("page size") }, required: ["sqlQuery"] } },
  { name: "ns_listAllReports", description: "List reports", inputSchema: { type: "object", properties: {} } },
  { name: "ns_runReport", description: "Run a report", inputSchema: { type: "object", properties: { reportId: num("id"), dateFrom: str("from"), dateTo: str("to") }, required: ["reportId"] } },
  { name: "ns_runSavedSearch", description: "Run a saved search", inputSchema: { type: "object", properties: { searchId: str("id"), type: str("type"), range_start: num("start"), range_end: num("end") }, required: ["searchId"] } },
];

function rows(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ tranid: `INV${10000 + i}`, trandate: `2026-0${1 + (i % 9)}-1${i % 9}`, entity: `Customer ${i % 412}`, amount: ((i * 37) % 9000) + 0.5, subsidiary: `Sub ${i % 4}`, id: i + 1 });
  return out;
}

function call(name, args) {
  switch (name) {
    case "ns_runCustomSuiteQL": {
      const big = /big/i.test(args.sqlQuery ?? "");
      return { content: [{ type: "text", text: JSON.stringify({ items: rows(big ? 3000 : 3), hasMore: false }) }] };
    }
    case "ns_listAllReports":
      return { content: [{ type: "text", text: JSON.stringify({ reports: [{ id: 12, name: "Income Statement", category: "Financial" }, { id: -200, name: "A/R Aging Summary", category: "Receivables" }] }) }] };
    case "ns_runReport":
      return { isError: true, content: [{ type: "text", text: "Error: 429 Too Many Requests - concurrency limit exceeded" }] };
    case "ns_runSavedSearch":
      return { content: [{ type: "text", text: JSON.stringify({ results: rows(Number(args.range_end ?? 1000) - Number(args.range_start ?? 0)) }) }] };
    default:
      return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
  }
}

const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notification
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-netsuite", version: "0.0.1" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === "tools/call") {
    log({ tool: msg.params.name, args: msg.params.arguments });
    send({ jsonrpc: "2.0", id: msg.id, result: call(msg.params.name, msg.params.arguments ?? {}) });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
