import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function parseToolJson(callResult) {
  assert.ok(Array.isArray(callResult.content) && callResult.content.length > 0);
  const txt = callResult.content[0].text;
  return JSON.parse(txt);
}

test("Standalone bundled dist/mcp-server.mjs works without node_modules over stdio MCP (offline + live mock)", async () => {
  const isoDir = mkdtempSync(join(tmpdir(), "jev-mcp-iso-"));
  const dataDir = join(isoDir, "plugin-data");
  mkdirSync(join(isoDir, "dist"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  // Copy ONLY plugin manifest and compiled standalone bundle -> ZERO node_modules in isoDir!
  cpSync(join(repoRoot, "plugin.json"), join(isoDir, "plugin.json"));
  cpSync(join(repoRoot, "dist", "mcp-server.mjs"), join(isoDir, "dist", "mcp-server.mjs"));

  // 1. Offline mode (NO OPENROUTER_API_KEY set)
  const offlineTransport = new StdioClientTransport({
    command: "node",
    args: [join(isoDir, "dist", "mcp-server.mjs")],
    cwd: isoDir,
    env: {
      PATH: process.env.PATH,
      HOME: isoDir,
      PLUGIN_ROOT: isoDir,
      PLUGIN_DATA: dataDir,
    },
  });
  const offlineClient = new Client({ name: "mcp-test-client", version: "1.0.0" });

  try {
    await offlineClient.connect(offlineTransport);

    const toolsResp = await offlineClient.listTools();
    const toolNames = new Set(toolsResp.tools.map((t) => t.name));
    assert.deepEqual(
      toolNames,
      new Set([
        "jev_decide",
        "jev_decide_batch",
        "jev_list_recipes",
        "jev_run_recipe",
        "jev_calibrate_auto",
        "jev_calibration_profiles",
        "jev_lint_design",
        "jev_models_and_router",
      ]),
    );

    const resourcesResp = await offlineClient.listResources();
    assert.equal(resourcesResp.resources.length, 3);
    const tsRuleRes = await offlineClient.readResource({ uri: "jev://docs/typesafe-rules" });
    assert.ok(tsRuleRes.contents[0].text.includes("Model Jaggedness"));

    const promptsResp = await offlineClient.listPrompts();
    assert.equal(promptsResp.prompts.length, 3);
    const auditPrompt = await offlineClient.getPrompt({
      name: "jev-audit-codebase",
      arguments: { targetPath: "src/" },
    });
    assert.ok(auditPrompt.messages[0].content.text.includes("src/"));

    // Offline jev_list_recipes
    const recipesRes = await offlineClient.callTool({ name: "jev_list_recipes", arguments: {} });
    assert.equal(recipesRes.isError ?? false, false);
    assert.equal(parseToolJson(recipesRes).count, 10);

    // Offline jev_lint_design
    const lintRes = await offlineClient.callTool({
      name: "jev_lint_design",
      arguments: {
        model: "typesafe/jev-1.13",
        state: "hello",
        questions: { loc: { type: "box", instructions: "the button" } },
      },
    });
    assert.equal(parseToolJson(lintRes).status, "fail");

    // Offline jev_calibrate_auto using precomputedAnswer ($0!) + profile retune + get
    const calRes = await offlineClient.callTool({
      name: "jev_calibrate_auto",
      arguments: {
        profileId: "offline-noul",
        questionId: "is_valid",
        question: { type: "noul", instructions: "Valid refund?" },
        samples: [
          { id: "s1", state: "dup", label: true, precomputedAnswer: { type: "noul", noul: 0.94 } },
          { id: "s2", state: "dup2", label: true, precomputedAnswer: { type: "noul", noul: 0.91 } },
          { id: "s3", state: "bad1", label: false, precomputedAnswer: { type: "noul", noul: 0.08 } },
          { id: "s4", state: "bad2", label: false, precomputedAnswer: { type: "noul", noul: 0.12 } },
        ],
      },
    });
    const calJson = parseToolJson(calRes);
    assert.equal(calJson.offlineMode, true);
    assert.equal(calJson.totalCostUsd, 0);

    const retuneRes = await offlineClient.callTool({
      name: "jev_calibration_profiles",
      arguments: {
        action: "retune",
        profileId: "offline-noul",
        minApprovePrecision: 0.95,
      },
    });
    assert.equal(parseToolJson(retuneRes).retunedOfflineUsd, 0);

    // Missing API key produces clean actionable tool error (NOT server crash)
    const missingKeyCall = await offlineClient.callTool({
      name: "jev_decide",
      arguments: {
        state: "ping",
        questions: { q: { type: "noul", instructions: "Ping?" } },
      },
    });
    assert.equal(missingKeyCall.isError, true);
    assert.ok(missingKeyCall.content[0].text.includes("OPENROUTER_API_KEY"));
  } finally {
    await offlineClient.close();
  }

  // 2. Live mock-OpenRouter stdio test exercising jev_decide, jev_run_recipe, jev_models_and_router
  const mockServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;

    if (req.url === "/api/alpha/decisions") {
      return res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(
          JSON.stringify({
            id: "dec_stdio",
            model: body.model,
            provider: "TypeSafe",
            answers: Object.fromEntries(
              Object.entries(body.questions).map(([k, q]) => {
                if (q.type === "noul") return [k, { type: "noul", noul: 0.93 }];
                if (q.type === "choice") {
                  const keys = Object.keys(q.criteria);
                  return [
                    k,
                    {
                      type: "choice",
                      choice: keys[0],
                      probabilities: Object.fromEntries(
                        keys.map((opt, idx) => [opt, idx === 0 ? 0.9 : 0.1 / Math.max(1, keys.length - 1)]),
                      ),
                    },
                  ];
                }
                return [
                  k,
                  { type: "score", score: 2.0, probabilities: { "0": 0.05, "1": 0.15, "2": 0.8 } },
                ];
              }),
            ),
            usage: { input_tokens: 120, output_tokens: 0, cost: 0.00000504 },
          }),
        );
    }
    if (req.url === "/api/v1/key") {
      return res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ data: { limit_remaining: 42 } }));
    }
    res.writeHead(404).end();
  });

  await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
  const mockUrl = `http://127.0.0.1:${mockServer.address().port}`;

  const onlineTransport = new StdioClientTransport({
    command: "node",
    args: [join(isoDir, "dist", "mcp-server.mjs")],
    cwd: isoDir,
    env: {
      PATH: process.env.PATH,
      HOME: isoDir,
      PLUGIN_ROOT: isoDir,
      PLUGIN_DATA: dataDir,
      OPENROUTER_API_KEY: "sk-or-live-mock",
      OPENROUTER_BASE_URL: mockUrl,
    },
  });
  const onlineClient = new Client({ name: "mcp-online-test", version: "1.0.0" });

  try {
    await onlineClient.connect(onlineTransport);

    // Apply previously stored offline calibration profile directly in jev_decide!
    const decideCall = await onlineClient.callTool({
      name: "jev_decide",
      arguments: {
        state: { refund_reason: "Duplicate charge" },
        questions: { is_valid: { type: "noul", instructions: "Is this refund valid?" } },
        calibrationProfileId: "offline-noul",
      },
    });
    const decideJson = parseToolJson(decideCall);
    assert.equal(decideJson.model, "typesafe/jev-1.14");
    assert.equal(decideJson.calibratedResult.routeAction, "approve");

    const recipeCall = await onlineClient.callTool({
      name: "jev_run_recipe",
      arguments: { recipeId: "support-triage", dryRunExample: true },
    });
    const recipeJson = parseToolJson(recipeCall);
    assert.equal(recipeJson.recipeId, "support-triage");

    const keyCall = await onlineClient.callTool({
      name: "jev_models_and_router",
      arguments: { action: "key_status" },
    });
    assert.equal(parseToolJson(keyCall).data.limit_remaining, 42);
  } finally {
    await onlineClient.close();
    await new Promise((r) => mockServer.close(r));
    rmSync(isoDir, { recursive: true, force: true });
  }
});

test("Local installer and strict validator scripts execute cleanly in isolated target home", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "jev-install-home-"));
  try {
    const validRaw = execFileSync(
      "node",
      [join(repoRoot, "scripts", "validate-plugin.mjs"), "--strict", "--json"],
      { encoding: "utf8" },
    );
    const validJson = JSON.parse(validRaw);
    assert.equal(validJson.valid, true);
    assert.equal(validJson.errorCount, 0);
    assert.equal(validJson.warningCount, 0);

    const installOut = execFileSync(
      "node",
      [
        join(repoRoot, "scripts", "install-local.mjs"),
        "--target-home",
        fakeHome,
        "--write-global-mcp",
      ],
      { encoding: "utf8" },
    );
    const installJson = JSON.parse(installOut);
    assert.equal(installJson.installed, true);
    assert.ok(existsSync(join(fakeHome, ".gemini", "config", "plugins", "jev-openrouter", "plugin.json")));
    assert.ok(existsSync(join(fakeHome, ".gemini", "config", "plugins", "jev-openrouter", "dist", "mcp-server.mjs")));

    const globalMcp = JSON.parse(
      readFileSync(join(fakeHome, ".gemini", "config", "mcp_config.json"), "utf8"),
    );
    assert.ok(globalMcp.mcpServers["jev-openrouter_jev"]);
    assert.equal(globalMcp.mcpServers["jev-openrouter_jev"].tools.jev_decide.eager, true);
    assert.equal(globalMcp.mcpServers["jev-openrouter_jev"].tools.jev_run_recipe.eager, true);
    assert.ok(existsSync(join(fakeHome, ".gemini", "config", "plugins", "jev-openrouter", "scripts", "install-windows.ps1")));
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
