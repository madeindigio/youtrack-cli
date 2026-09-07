import { hostname } from "node:os";
import { join } from "node:path";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";

/**
 * Embedded, file-backed job queue used to schedule remote work without
 * saturating the YouTrack server. Two interchangeable backends are provided:
 * a SQLite one (Bun or Node >= 22.5) and a pure-JS append-only journal.
 */

const STATUSES = ["pending", "running", "done", "failed"];
const MAX_BACKOFF_MS = 60_000;
const MAX_JITTER_MS = 250;
const MIN_JOURNAL_LINES = 64;
const COMPACTION_FACTOR = 4;

/**
 * Open (or create) a queue stored inside `directory`.
 * @param {string} directory
 * @param {{ backend?: "auto" | "sqlite" | "jsonl", fresh?: boolean }} [options]
 */
export async function openQueue(directory, { backend = "auto", fresh = false } = {}) {
  await mkdir(directory, { recursive: true });

  if (backend === "jsonl") return openJsonlQueue(directory, { fresh });

  const database = await createSqliteDatabase(join(directory, "queue.db"), { fresh });
  if (database) return createSqliteQueue(database);
  if (backend === "sqlite") throw new Error("No SQLite backend available in this runtime (need bun:sqlite or node:sqlite)");
  return openJsonlQueue(directory, { fresh });
}

/**
 * Acquire the single-coordinator lock for a queue directory.
 * @param {string} directory
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{ path: string, release: () => Promise<void> }>}
 */
export async function acquireLock(directory, { force = false } = {}) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "queue.lock");
  const body = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() });

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await rm(path, { force: true });
  };

  if (force) await rm(path, { force: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, body, { encoding: "utf8", flag: "wx" });
      return { path, release };
    } catch (error) {
      if (error.code !== "EEXIST" || attempt > 0) throw error;
      const holder = await readLockFile(path);
      if (holder && Number.isInteger(holder.pid) && isProcessAlive(holder.pid)) {
        throw new Error(`Queue is locked by pid ${holder.pid} on ${holder.host || "unknown host"}: ${path}`);
      }
      await rm(path, { force: true });
    }
  }

  throw new Error(`Could not acquire queue lock: ${path}`);
}

async function readLockFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error.code === "EPERM";
  }
}

function normalizeJob(job) {
  if (!job || typeof job.type !== "string" || job.type === "") throw new Error("Job requires a non-empty type");
  const payload = job.payload === undefined ? null : job.payload;
  return {
    type: job.type,
    key: job.key === undefined || job.key === null ? `${job.type}:${JSON.stringify(payload)}` : String(job.key),
    payload,
    priority: Number(job.priority ?? 0),
    runAt: Number(job.runAt ?? 0),
  };
}

function jobId(job) {
  const id = Number(job && typeof job === "object" ? job.id : job);
  if (!Number.isFinite(id)) throw new Error("Job record without a numeric id");
  return id;
}

function errorMessage(error) {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  return String(error);
}

function nextRunAt(attempts, backoffMs, now) {
  const delay = Math.min(backoffMs * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_MS);
  const jitter = Math.floor(Math.random() * Math.min(delay, MAX_JITTER_MS));
  return now + delay + jitter;
}

function emptyStats() {
  const stats = { total: 0 };
  for (const status of STATUSES) stats[status] = 0;
  return stats;
}

function compareReady(a, b) {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.id - b.id;
}

/* -------------------------------------------------------------------------- */
/* SQLite backend                                                             */
/* -------------------------------------------------------------------------- */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  run_at INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (status, priority DESC, run_at, id);
`;

async function createSqliteDatabase(path, { fresh }) {
  const database = await loadSqliteDatabase(path, { fresh });
  if (!database) return null;

  const adapter = {
    exec(sql) {
      if (typeof database.exec === "function") database.exec(sql);
      else database.run(sql);
    },
    prepare(sql) {
      return database.prepare(sql);
    },
    close() {
      database.close();
    },
  };

  adapter.exec("PRAGMA journal_mode = WAL;");
  adapter.exec("PRAGMA synchronous = NORMAL;");
  adapter.exec(SCHEMA);
  return adapter;
}

async function loadSqliteDatabase(path, { fresh }) {
  const create = async (factory) => {
    if (fresh) {
      for (const suffix of ["", "-wal", "-shm"]) await rm(`${path}${suffix}`, { force: true });
    }
    return factory();
  };

  try {
    const { Database } = await import("bun:sqlite");
    return await create(() => new Database(path, { create: true }));
  } catch {
    // Not running under Bun.
  }

  try {
    const { DatabaseSync } = await import("node:sqlite");
    return await create(() => new DatabaseSync(path));
  } catch {
    // Node < 22.5 has no built-in SQLite.
  }

  return null;
}

function sqliteRowToRecord(row) {
  return {
    id: Number(row.id),
    type: row.type,
    key: row.key,
    payload: JSON.parse(row.payload),
    status: row.status,
    attempts: Number(row.attempts),
    priority: Number(row.priority),
    runAt: Number(row.run_at),
    error: row.error ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function createSqliteQueue(db) {
  const statements = new Map();
  const stmt = (sql) => {
    let prepared = statements.get(sql);
    if (!prepared) {
      prepared = db.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  };

  const insert = (job, now) => {
    const result = stmt(
      "INSERT OR IGNORE INTO jobs (type, key, payload, status, attempts, priority, run_at, error, created_at, updated_at)"
      + " VALUES (?, ?, ?, 'pending', 0, ?, ?, NULL, ?, ?)",
    ).run(job.type, job.key, JSON.stringify(job.payload), job.priority, job.runAt, now, now);
    return Number(result.changes) > 0;
  };

  const selectById = (id) => {
    const row = stmt("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? sqliteRowToRecord(row) : null;
  };

  const transaction = (run) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction was already rolled back.
      }
      throw error;
    }
  };

  return {
    backend: "sqlite",

    async enqueue(job) {
      return insert(normalizeJob(job), Date.now());
    },

    async enqueueMany(jobs) {
      const now = Date.now();
      const normalized = [...jobs].map(normalizeJob);
      return transaction(() => normalized.reduce((count, job) => count + (insert(job, now) ? 1 : 0), 0));
    },

    async claim(count = 1) {
      if (count <= 0) return [];
      const now = Date.now();
      return transaction(() => {
        const rows = stmt(
          "SELECT id FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY priority DESC, id ASC LIMIT ?",
        ).all(now, count);
        const claimed = [];
        for (const row of rows) {
          const id = Number(row.id);
          stmt("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?").run(now, id);
          claimed.push(selectById(id));
        }
        return claimed;
      });
    },

    async complete(job) {
      stmt("UPDATE jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ?").run(Date.now(), jobId(job));
    },

    async fail(job, error, { maxAttempts = 5, backoffMs = 1000 } = {}) {
      const id = jobId(job);
      const now = Date.now();
      const current = selectById(id);
      if (!current) return null;

      const attempts = current.attempts + 1;
      const message = errorMessage(error);
      if (attempts >= maxAttempts) {
        stmt("UPDATE jobs SET status = 'failed', attempts = ?, error = ?, updated_at = ? WHERE id = ?")
          .run(attempts, message, now, id);
      } else {
        stmt("UPDATE jobs SET status = 'pending', attempts = ?, error = ?, run_at = ?, updated_at = ? WHERE id = ?")
          .run(attempts, message, nextRunAt(attempts, backoffMs, now), now, id);
      }
      return selectById(id);
    },

    async stats() {
      const stats = emptyStats();
      for (const row of stmt("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status").all()) {
        const count = Number(row.count);
        if (row.status in stats) stats[row.status] = count;
        stats.total += count;
      }
      return stats;
    },

    async listFailed(limit = 50) {
      return stmt("SELECT * FROM jobs WHERE status = 'failed' ORDER BY updated_at DESC, id ASC LIMIT ?")
        .all(limit)
        .map(sqliteRowToRecord);
    },

    async recoverRunning() {
      const result = stmt("UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running'").run(Date.now());
      return Number(result.changes);
    },

    async close() {
      statements.clear();
      db.close();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* JSONL backend                                                              */
/* -------------------------------------------------------------------------- */

async function openJsonlQueue(directory, { fresh }) {
  const path = join(directory, "queue.jsonl");
  const tempPath = `${path}.tmp`;
  if (fresh) {
    await rm(path, { force: true });
    await rm(tempPath, { force: true });
  }

  const state = {
    path,
    tempPath,
    records: new Map(),
    byKey: new Map(),
    lines: 0,
    nextId: 1,
    writes: Promise.resolve(),
    handle: null,
  };

  await replayJournal(state);
  state.handle = await open(path, "a");
  return createJsonlQueue(state);
}

async function replayJournal(state) {
  let text = "";
  try {
    text = await readFile(state.path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return;
  }

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // Ignore a truncated final line after a crash.
    }
    state.lines += 1;
    state.records.set(record.id, record);
    state.byKey.set(record.key, record.id);
    if (record.id >= state.nextId) state.nextId = record.id + 1;
  }
}

function createJsonlQueue(state) {
  const append = async (records) => {
    if (records.length === 0) return;
    const text = records.map((record) => `${JSON.stringify(record)}\n`).join("");
    state.writes = state.writes.then(() => state.handle.write(text));
    await state.writes;
    state.lines += records.length;
    await compactIfNeeded(state);
  };

  const insert = (job, now) => {
    if (state.byKey.has(job.key)) return null;
    const record = {
      id: state.nextId,
      type: job.type,
      key: job.key,
      payload: job.payload,
      status: "pending",
      attempts: 0,
      priority: job.priority,
      runAt: job.runAt,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    state.nextId += 1;
    state.records.set(record.id, record);
    state.byKey.set(record.key, record.id);
    return record;
  };

  const update = (id, changes) => {
    const current = state.records.get(id);
    if (!current) return null;
    const record = { ...current, ...changes, updatedAt: Date.now() };
    state.records.set(id, record);
    return record;
  };

  return {
    backend: "jsonl",

    async enqueue(job) {
      const record = insert(normalizeJob(job), Date.now());
      if (!record) return false;
      await append([record]);
      return true;
    },

    async enqueueMany(jobs) {
      const now = Date.now();
      const inserted = [];
      for (const job of jobs) {
        const record = insert(normalizeJob(job), now);
        if (record) inserted.push(record);
      }
      await append(inserted);
      return inserted.length;
    },

    async claim(count = 1) {
      if (count <= 0) return [];
      const now = Date.now();
      const ready = [];
      for (const record of state.records.values()) {
        if (record.status === "pending" && record.runAt <= now) ready.push(record);
      }
      const claimed = ready.sort(compareReady).slice(0, count).map((record) => update(record.id, { status: "running" }));
      await append(claimed);
      return claimed.map((record) => ({ ...record }));
    },

    async complete(job) {
      const record = update(jobId(job), { status: "done", error: null });
      if (record) await append([record]);
    },

    async fail(job, error, { maxAttempts = 5, backoffMs = 1000 } = {}) {
      const id = jobId(job);
      const current = state.records.get(id);
      if (!current) return null;

      const attempts = current.attempts + 1;
      const message = errorMessage(error);
      const record = attempts >= maxAttempts
        ? update(id, { status: "failed", attempts, error: message })
        : update(id, { status: "pending", attempts, error: message, runAt: nextRunAt(attempts, backoffMs, Date.now()) });
      await append([record]);
      return { ...record };
    },

    async stats() {
      const stats = emptyStats();
      for (const record of state.records.values()) {
        if (record.status in stats) stats[record.status] += 1;
        stats.total += 1;
      }
      return stats;
    },

    async listFailed(limit = 50) {
      return [...state.records.values()]
        .filter((record) => record.status === "failed")
        .sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id - b.id))
        .slice(0, limit)
        .map((record) => ({ ...record }));
    },

    async recoverRunning() {
      const recovered = [];
      for (const record of [...state.records.values()]) {
        if (record.status === "running") recovered.push(update(record.id, { status: "pending" }));
      }
      await append(recovered);
      return recovered.length;
    },

    async close() {
      await state.writes;
      if (state.handle) {
        await state.handle.close();
        state.handle = null;
      }
    },
  };
}

/**
 * Rewrite the journal with only the live records once it grew too much.
 */
async function compactIfNeeded(state) {
  const live = state.records.size;
  if (state.lines <= MIN_JOURNAL_LINES || state.lines <= live * COMPACTION_FACTOR) return;

  const text = [...state.records.values()].map((record) => `${JSON.stringify(record)}\n`).join("");
  state.writes = state.writes.then(async () => {
    await writeFile(state.tempPath, text, "utf8");
    await state.handle.close();
    await rename(state.tempPath, state.path);
    state.handle = await open(state.path, "a");
    state.lines = live;
  });
  await state.writes;
}
