#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("..", import.meta.url).pathname;
const evidenceRoot = process.env.NOSTR_SCHEDULER_EVIDENCE ?? join(tmpdir(), "nostr-scheduler-verify");

function runId() {
  return process.env.NOSTR_SCHEDULER_RUN_ID ?? "latest";
}

function evidenceDir() {
  return join(evidenceRoot, runId());
}

function doctor() {
  const major = Number(process.versions.node.split(".")[0]);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lines = [
    `node ${process.versions.node}`,
    `package ${pkg.name}`,
    `evidence ${evidenceDir()}`,
  ];
  if (major < 22) {
    console.error(lines.concat("node 22 or newer is required").join("\n"));
    process.exit(1);
  }
  if (pkg.name !== "nostr-scheduler") {
    console.error("package name is not nostr-scheduler");
    process.exit(1);
  }
  console.log(lines.join("\n"));
}

function drive() {
  const id = runId();
  const dir = evidenceDir();
  const dataDir = join(tmpdir(), `nostr-scheduler-data-${id}`);
  mkdirSync(dir, { recursive: true });
  rmSync(dataDir, { recursive: true, force: true });
  const child = spawn("pnpm", ["demo:local"], {
    cwd: root,
    env: {
      ...process.env,
      NOSTR_SCHEDULER_MODE: "demo",
      NOSTR_SCHEDULER_DATA: dataDir,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("close", (code) => {
    writeFileSync(join(dir, "stdout.txt"), stdout);
    writeFileSync(join(dir, "stderr.txt"), stderr);
    writeFileSync(join(dir, "exit-code.txt"), `${code ?? 1}\n`);
    writeFileSync(join(dir, "data-dir.txt"), `${dataDir}\n`);
    writeFileSync(
      join(dir, "summary.txt"),
      [
        `command pnpm demo:local`,
        `data ${dataDir}`,
        `exit ${code ?? 1}`,
        ...stdout.trim().split("\n").filter((line) => /^(relay|sent|future|missed|sent-on-relay|future-on-relay|missed-on-relay) /.test(line)),
      ].join("\n") + "\n",
    );
    if (code !== 0 || !stdout.includes("sent-on-relay yes") || !stdout.includes("future-on-relay no") || !stdout.includes("missed-on-relay no")) {
      console.error(stdout);
      console.error(stderr);
      process.exit(code || 1);
    }
    console.log(readFileSync(join(dir, "summary.txt"), "utf8").trim());
  });
}

function cleanup() {
  const dir = evidenceDir();
  const marker = join(dir, "data-dir.txt");
  if (existsSync(marker)) {
    const dataDir = readFileSync(marker, "utf8").trim();
    if (dataDir.startsWith(tmpdir())) rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(`kept ${dir}`);
}

const command = process.argv[2];
if (command === "doctor") doctor();
else if (command === "drive") drive();
else if (command === "cleanup") cleanup();
else {
  console.error("usage: verify.mjs doctor|drive|cleanup");
  process.exit(1);
}
