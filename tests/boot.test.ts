/**
 * The entry point, as an operator meets it.
 *
 * Every other test in this repository calls a function. This one spawns
 * `bin/manak.ts` as a process, reads its stdout and sends it a signal, because the
 * claims being made here are not about the server — they are about the thing somebody
 * actually runs, and none of them can be asserted from inside the same process:
 *
 *   - **It says where it is, and it is there.** The port is parsed out of the line the
 *     program prints and then used to make a request. A banner that names a port
 *     nothing is listening on is the single most wasteful five minutes a person
 *     evaluating a self-hosted product can have.
 *   - **A mistyped setting stops it before it opens anything.** `MANAK_TRUST_PROXY=maybe`
 *     silently meaning false is a security misconfiguration that never announces itself,
 *     so it exits 1 — and it does so before the database line is printed, which is how
 *     the test knows no migration was applied first.
 *   - **SIGTERM is a stop, not a kill.** A container is asked to stop this way, and the
 *     default answer drops requests in flight and leaves a write-ahead log to recover.
 *   - **`--help` names every setting the file reads.** Asserted against the source rather
 *     than against a list, so an environment variable added without a help entry fails
 *     here instead of being discovered by somebody reading the code.
 *
 * The signal test does not run on Windows. `process.kill` there terminates
 * unconditionally whatever name is passed, so a graceful-stop assertion would be
 * failing on a platform difference rather than on this program — and the deployment
 * target for the claim is a container.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../bin/manak.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Long enough for a cold start under a loaded test runner, short enough to fail a hang. */
const PATIENCE = 20_000;

type Booted = {
  readonly pid: number;
  /** Everything written to stdout so far. */
  out: () => string;
  /** Everything written to stderr so far, minus Node's SQLite warning. */
  err: () => string;
  /** Resolves once `pattern` appears in stdout, or rejects when patience runs out. */
  until: (pattern: RegExp) => Promise<string>;
  signal: (name: "SIGTERM" | "SIGINT") => void;
  /** The exit code, waited for. Null means it died of a signal. */
  ended: () => Promise<number | null>;
};

/**
 * Run the entry point with a clean environment.
 *
 * The parent's `MANAK_*` variables are stripped rather than inherited. A developer who
 * exported one into their shell would otherwise change what these tests assert, and the
 * failure would appear on their machine only.
 */
function boot(settings: Record<string, string>, args: readonly string[] = []): Booted {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("MANAK_") && name !== "PORT"),
  );
  const child = spawn(process.execPath, ["--experimental-strip-types", ENTRY, ...args], {
    cwd: ROOT,
    env: { ...inherited, ...settings },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  const waiting: { pattern: RegExp; settle: () => void }[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    out += chunk;
    for (const one of [...waiting]) {
      if (one.pattern.test(out)) {
        waiting.splice(waiting.indexOf(one), 1);
        one.settle();
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    err += chunk;
  });
  const finished = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      // Wake anything still waiting, so a test asserting on a line that never arrived
      // fails on the assertion with the output in hand rather than on a timeout.
      for (const one of waiting.splice(0)) one.settle();
      resolve(code);
    });
  });

  return {
    pid: child.pid ?? -1,
    out: () => out,
    err: () =>
      err
        .split("\n")
        .filter((line) => !line.includes("ExperimentalWarning") && !line.includes("trace-warnings"))
        .join("\n"),
    until: (pattern) =>
      new Promise<string>((resolve, reject) => {
        if (pattern.test(out)) return resolve(out);
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${pattern} never appeared. stdout so far:\n${out}`));
        }, PATIENCE);
        waiting.push({
          pattern,
          settle: () => {
            clearTimeout(timer);
            resolve(out);
          },
        });
      }),
    signal: (name) => child.kill(name),
    ended: () => finished,
  };
}

/** The address in the banner, or a thrown error naming what was printed instead. */
function announced(output: string): string {
  const found = /\[boot\] listening on (\S+)/.exec(output);
  if (found === null) throw new Error(`no address in the banner:\n${output}`);
  return found[1] as string;
}

/** Port 0 and an in-memory database, so nothing on the machine is touched or held. */
const EPHEMERAL = { MANAK_DATABASE: ":memory:", MANAK_PORT: "0", MANAK_HOST: "127.0.0.1" };

test("it announces the database, the schema, the ledger, the mail and the address, in order", async () => {
  const server = boot(EPHEMERAL);
  try {
    const output = await server.until(/\[boot\] listening on/);
    const lines = output.split("\n").filter((line) => line.startsWith("[boot]"));
    assert.match(lines[0] as string, /^\[boot\] database :memory:$/);
    assert.match(lines[1] as string, /^\[boot\] applied \d+ migration\(s\): /);
    // The head hash of an empty chain is the genesis constant, and printing it at boot is
    // what makes a later one comparable by eye.
    assert.match(lines[2] as string, /^\[boot\] ledger sound, 0 entries, head 0{64}$/);
    assert.match(lines[3] as string, /nobody can create an event over HTTP/);
    // Printed even though it is the default, and that is the point: until somebody knows the
    // link is in this stream they cannot sign in at all, and nobody reads `--help` first.
    assert.match(lines[4] as string, /^\[boot\] no mail relay configured, so sign-in links are printed to this log/);
    assert.match(lines[5] as string, /^\[boot\] listening on http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(server.err(), "");
  } finally {
    server.signal("SIGTERM");
    await server.ended();
  }
});

test("the port it names is the port it answers on, and a request is logged as one line", async () => {
  const server = boot(EPHEMERAL);
  try {
    const address = announced(await server.until(/\[boot\] listening on/));
    // 0 was asked for, so the number in the banner is the operating system's answer and
    // there is no other way to learn it. A banner that were wrong would fail here.
    assert.notEqual(new URL(address).port, "0");

    const response = await fetch(`${address}/api/events`, { headers: { accept: "*/*" } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { events?: unknown[] };
    assert.deepEqual(body.events, []);

    const logged = await server.until(/events\.list/);
    const line = logged.split("\n").find((one) => one.includes("events.list")) as string;
    assert.match(line, /^\S+Z 200 GET {2}\/api\/events \d+ms command=events\.list account=-$/);
  } finally {
    server.signal("SIGTERM");
    await server.ended();
  }
});

test("a setting that is not plainly a boolean stops it before it opens the database", async () => {
  const server = boot({ ...EPHEMERAL, MANAK_TRUST_PROXY: "maybe" });
  const code = await server.ended();
  assert.equal(code, 1);
  assert.match(server.err(), /\[fatal\] MANAK_TRUST_PROXY is "maybe"/);
  // The absence is the assertion. `[boot] database` is printed inside the function that
  // opens the file and migrates it, so a run that never printed it never touched anybody's
  // data — which is the whole reason the settings are read first.
  assert.doesNotMatch(server.out(), /\[boot\]/);
});

test("a port that cannot exist stops it, and says what a port looks like", async () => {
  const server = boot({ ...EPHEMERAL, MANAK_PORT: "eighty" });
  assert.equal(await server.ended(), 1);
  assert.match(server.err(), /\[fatal\] the port is "eighty"; write a whole number from 0 to 65535/);
  assert.doesNotMatch(server.out(), /\[boot\]/);
});

test("a configured relay is announced with everything but the password", async () => {
  // Nothing is listening on that port and nothing needs to be: a relay is not contacted until
  // a message is queued, so this asserts the settings were read and reported, not that they work.
  const server = boot({
    ...EPHEMERAL,
    MANAK_SMTP_HOST: "relay.internal",
    MANAK_SMTP_FROM: "Manak <portal@example.test>",
    MANAK_SMTP_USER: "portal@example.test",
    MANAK_SMTP_PASSWORD: "hunter2-but-an-app-password",
    MANAK_SMTP_ENCRYPTION: "starttls",
  });
  try {
    const output = await server.until(/\[boot\] listening on/);
    assert.match(
      output,
      /^\[boot\] sending mail as portal@example\.test through relay\.internal:587 over starttls, as portal@example\.test$/m,
    );
    // The banner names the sender, the relay, the encryption and the account, because each is
    // something a relay refusing this deployment is usually about. The password is not one of
    // them, and a log line that carried it would be a credential in the operator's log.
    assert.ok(!output.includes("hunter2"), "the password reached stdout");
    assert.equal(server.err(), "");
  } finally {
    server.signal("SIGTERM");
    await server.ended();
  }
});

test("587 is assumed for a negotiated connection and 465 for an encrypted one", async () => {
  const server = boot({
    ...EPHEMERAL,
    MANAK_SMTP_HOST: "relay.internal",
    MANAK_SMTP_FROM: "portal@example.test",
    MANAK_SMTP_ENCRYPTION: "tls",
  });
  try {
    const output = await server.until(/\[boot\] listening on/);
    assert.match(output, /through relay\.internal:465 over tls, unauthenticated$/m);
  } finally {
    server.signal("SIGTERM");
    await server.ended();
  }
});

test("a relay with no sender stops it, because there is no sender worth guessing", async () => {
  const server = boot({ ...EPHEMERAL, MANAK_SMTP_HOST: "relay.internal" });
  assert.equal(await server.ended(), 1);
  assert.match(server.err(), /\[fatal\] MANAK_SMTP_HOST is set but MANAK_SMTP_FROM is not/);
  // Before the database again. Every setting is read first for exactly this reason.
  assert.doesNotMatch(server.out(), /\[boot\]/);
});

test("a password with nothing to send it as stops it, rather than being quietly unused", async () => {
  const server = boot({
    ...EPHEMERAL,
    MANAK_SMTP_HOST: "relay.internal",
    MANAK_SMTP_FROM: "portal@example.test",
    MANAK_SMTP_PASSWORD: "unused",
  });
  assert.equal(await server.ended(), 1);
  assert.match(server.err(), /MANAK_SMTP_PASSWORD is set but MANAK_SMTP_USER is not/);
  assert.doesNotMatch(server.out(), /\[boot\]/);
});

test("a password on an unencrypted connection stops it at boot, not at the first message", async () => {
  const server = boot({
    ...EPHEMERAL,
    MANAK_SMTP_HOST: "relay.internal",
    MANAK_SMTP_FROM: "portal@example.test",
    MANAK_SMTP_USER: "portal@example.test",
    MANAK_SMTP_PASSWORD: "readable-by-every-hop",
    MANAK_SMTP_ENCRYPTION: "none",
  });
  assert.equal(await server.ended(), 1);
  assert.match(server.err(), /MANAK_SMTP_USER is set with MANAK_SMTP_ENCRYPTION=none/);
  assert.ok(!server.err().includes("readable-by-every-hop"), "the password reached stderr");
  assert.doesNotMatch(server.out(), /\[boot\]/);
});

test("a sender that is not an address stops it, and the message names the setting", async () => {
  const server = boot({ ...EPHEMERAL, MANAK_SMTP_HOST: "relay.internal", MANAK_SMTP_FROM: "Manak <not an address>" });
  assert.equal(await server.ended(), 1);
  assert.match(server.err(), /\[fatal\] MANAK_SMTP_FROM is not an address this can send to/);
  assert.doesNotMatch(server.out(), /\[boot\]/);
});

test("SIGTERM is a stop rather than a kill", { skip: process.platform === "win32" }, async () => {
  const server = boot(EPHEMERAL);
  await server.until(/\[boot\] listening on/);
  server.signal("SIGTERM");
  const code = await server.ended();
  // Zero, not null. A null code means the default handler ran and the process died of the
  // signal, which is what happens when nothing is listening for it — and is exactly the
  // regression this test exists to catch.
  assert.equal(code, 0);
  assert.match(server.out(), /\[stop\] SIGTERM, finishing what is in flight/);
  assert.match(server.out(), /\[stop\] closed/);
});

test("--help names every setting the program reads", async () => {
  const server = boot(EPHEMERAL, ["--help"]);
  assert.equal(await server.ended(), 0);
  const help = server.out();
  // Read out of the source rather than listed here, so a variable added to the file without
  // a line in the help text fails this test instead of going unmentioned. Every occurrence
  // in the file is either a use of the setting or a mention in the help text itself, and
  // both should appear in the output for the same reason.
  const source = readFileSync(ENTRY, "utf8");
  const named = new Set(source.match(/MANAK_[A-Z_]+/g) ?? []);
  assert.ok(named.size >= 5, `only found ${named.size} settings in the source`);
  assert.deepEqual(
    [...named].filter((name) => !help.includes(name)),
    [],
  );
  // Nothing was started: no port was bound and no database was opened.
  assert.doesNotMatch(help, /\[boot\]/);
});
