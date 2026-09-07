import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireLock, openQueue } from "../src/queue.js";

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), "youtrack-queue-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function sqliteAvailable() {
  for (const specifier of ["bun:sqlite", "node:sqlite"]) {
    try {
      await import(specifier);
      return true;
    } catch {
      // Try the next runtime module.
    }
  }
  return false;
}

/**
 * Shared behaviour every backend must implement.
 */
function runContractTests(backend) {
  const open = (directory, options = {}) => openQueue(directory, { backend, ...options });

  test(`[${backend}] enqueue dedupes by key and reports insertions`, async () => {
    await withTempDir(async (directory) => {
      const queue = await open(directory);
      assert.equal(queue.backend, backend);

      assert.equal(await queue.enqueue({ type: "issue:fetch", key: "issue:A-1", payload: { id: "A-1" } }), true);
      assert.equal(await queue.enqueue({ type: "issue:fetch", key: "issue:A-1", payload: { id: "A-1" } }), false);

      // The default key is derived from the type and the payload.
      assert.equal(await queue.enqueue({ type: "issue:fetch", payload: { id: "A-2" } }), true);
      assert.equal(await queue.enqueue({ type: "issue:fetch", payload: { id: "A-2" } }), false);

      assert.equal(await queue.enqueueMany([
        { type: "issue:fetch", key: "issue:A-1", payload: { id: "A-1" } },
        { type: "issue:fetch", key: "issue:A-3", payload: { id: "A-3" } },
      ]), 1);

      assert.deepEqual(await queue.stats(), { pending: 3, running: 0, done: 0, failed: 0, total: 3 });
      await queue.close();
    });
  });

  test(`[${backend}] claim marks jobs running and never hands one out twice`, async () => {
    await withTempDir(async (directory) => {
      const queue = await open(directory);
      await queue.enqueueMany([
        { type: "a", key: "a", payload: 1 },
        { type: "b", key: "b", payload: 2 },
        { type: "c", key: "c", payload: 3, priority: 10 },
      ]);

      const [first] = await queue.claim(1);
      assert.equal(first.key, "c", "highest priority first");
      assert.equal(first.status, "running");
      assert.equal(first.payload, 3);

      const rest = await queue.claim(5);
      assert.deepEqual(rest.map((job) => job.key), ["a", "b"], "insertion order for equal priority");
      assert.deepEqual(await queue.claim(5), []);

      assert.deepEqual(await queue.stats(), { pending: 0, running: 3, done: 0, failed: 0, total: 3 });
      await queue.close();
    });
  });

  test(`[${backend}] complete and fail move jobs through their states`, async () => {
    await withTempDir(async (directory) => {
      const queue = await open(directory);
      await queue.enqueueMany([
        { type: "a", key: "a", payload: null },
        { type: "b", key: "b", payload: null },
      ]);

      const [a, b] = await queue.claim(2);
      await queue.complete(a);

      const retried = await queue.fail(b, new Error("boom"), { maxAttempts: 5, backoffMs: 10_000 });
      assert.equal(retried.status, "pending");
      assert.equal(retried.attempts, 1);
      assert.equal(retried.error, "boom");
      assert.ok(retried.runAt > Date.now(), "retry is scheduled in the future");

      // The backoff keeps the job out of the ready set.
      assert.deepEqual(await queue.claim(5), []);
      assert.deepEqual(await queue.stats(), { pending: 1, running: 0, done: 1, failed: 0, total: 2 });
      await queue.close();
    });
  });

  test(`[${backend}] fail gives up after maxAttempts and records the failure`, async () => {
    await withTempDir(async (directory) => {
      const queue = await open(directory);
      await queue.enqueue({ type: "a", key: "a", payload: null });

      const [job] = await queue.claim(1);
      const failed = await queue.fail(job, new Error("permanent"), { maxAttempts: 1, backoffMs: 0 });
      assert.equal(failed.status, "failed");
      assert.equal(failed.attempts, 1);

      assert.deepEqual(await queue.claim(5), []);
      assert.deepEqual(await queue.stats(), { pending: 0, running: 0, done: 0, failed: 1, total: 1 });

      const failures = await queue.listFailed(10);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].key, "a");
      assert.equal(failures[0].error, "permanent");
      await queue.close();
    });
  });

  test(`[${backend}] retries become claimable again once the backoff elapsed`, async () => {
    await withTempDir(async (directory) => {
      const queue = await open(directory);
      await queue.enqueue({ type: "a", key: "a", payload: null });

      const [job] = await queue.claim(1);
      await queue.fail(job, "transient", { maxAttempts: 5, backoffMs: 0 });

      const [again] = await queue.claim(1);
      assert.equal(again.id, job.id);
      assert.equal(again.attempts, 1);
      await queue.close();
    });
  });

  test(`[${backend}] state survives close and reopen, and running jobs are recoverable`, async () => {
    await withTempDir(async (directory) => {
      const first = await open(directory);
      await first.enqueueMany([
        { type: "a", key: "a", payload: { n: 1 } },
        { type: "b", key: "b", payload: { n: 2 } },
      ]);
      const [claimed] = await first.claim(1);
      await first.close();

      const second = await open(directory);
      assert.deepEqual(await second.stats(), { pending: 1, running: 1, done: 0, failed: 0, total: 2 });
      assert.equal(await second.enqueue({ type: "a", key: "a", payload: { n: 1 } }), false);

      assert.equal(await second.recoverRunning(), 1);
      assert.deepEqual(await second.stats(), { pending: 2, running: 0, done: 0, failed: 0, total: 2 });

      const keys = (await second.claim(5)).map((job) => job.key);
      assert.equal(keys.length, 2);
      assert.ok(keys.includes(claimed.key));
      await second.close();
    });
  });

  test(`[${backend}] fresh discards previous state`, async () => {
    await withTempDir(async (directory) => {
      const first = await open(directory);
      await first.enqueue({ type: "a", key: "a", payload: null });
      await first.close();

      const second = await open(directory, { fresh: true });
      assert.deepEqual(await second.stats(), { pending: 0, running: 0, done: 0, failed: 0, total: 0 });
      assert.equal(await second.enqueue({ type: "a", key: "a", payload: null }), true);
      await second.close();
    });
  });
}

runContractTests("jsonl");

if (await sqliteAvailable()) {
  runContractTests("sqlite");
} else {
  test("sqlite backend is unavailable in this runtime", async () => {
    await withTempDir(async (directory) => {
      await assert.rejects(() => openQueue(directory, { backend: "sqlite" }), /No SQLite backend/);
      const queue = await openQueue(directory, { backend: "auto" });
      assert.equal(queue.backend, "jsonl");
      await queue.close();
    });
  });
}

test("jsonl journal is compacted while keeping the state correct", async () => {
  await withTempDir(async (directory) => {
    const queue = await openQueue(directory, { backend: "jsonl" });
    const journal = join(directory, "queue.jsonl");

    await queue.enqueueMany([1, 2, 3, 4, 5].map((n) => ({ type: "a", key: `k${n}`, payload: n })));
    for (let round = 0; round < 20; round += 1) {
      const jobs = await queue.claim(5);
      assert.equal(jobs.length, 5);
      for (const job of jobs) await queue.fail(job, "retry", { maxAttempts: 1000, backoffMs: 0 });
    }

    const lines = (await readFile(journal, "utf8")).split("\n").filter(Boolean);
    assert.ok(lines.length < 205, `journal was compacted, got ${lines.length} lines`);
    assert.deepEqual(await queue.stats(), { pending: 5, running: 0, done: 0, failed: 0, total: 5 });
    await queue.close();

    const reopened = await openQueue(directory, { backend: "jsonl" });
    assert.deepEqual(await reopened.stats(), { pending: 5, running: 0, done: 0, failed: 0, total: 5 });
    const jobs = await reopened.claim(5);
    assert.deepEqual(jobs.map((job) => job.key).sort(), ["k1", "k2", "k3", "k4", "k5"]);
    assert.equal(jobs[0].attempts, 20);
    await reopened.close();
  });
});

test("acquireLock guards a directory until it is released", async () => {
  await withTempDir(async (directory) => {
    const lock = await acquireLock(directory);
    assert.equal(lock.path, join(directory, "queue.lock"));

    await assert.rejects(() => acquireLock(directory), new RegExp(`locked by pid ${process.pid}`));

    await lock.release();
    await lock.release(); // release() is idempotent.

    const second = await acquireLock(directory);
    await second.release();
  });
});

test("acquireLock takes over a stale lock and honours force", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "queue.lock");
    await writeFile(path, JSON.stringify({ pid: 4194303, host: "ghost", startedAt: 0 }), "utf8");

    const stale = await acquireLock(directory);
    const holder = JSON.parse(await readFile(path, "utf8"));
    assert.equal(holder.pid, process.pid);
    await stale.release();

    await writeFile(path, "not json at all", "utf8");
    const corrupt = await acquireLock(directory);
    await corrupt.release();

    const held = await acquireLock(directory);
    const forced = await acquireLock(directory, { force: true });
    assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
    await forced.release();
    await held.release();
  });
});
