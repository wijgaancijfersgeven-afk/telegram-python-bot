import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type BotUser = {
  id: number;
  telegramUserId: number;
  telegramChatId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  role: "user" | "admin";
  status: "pending" | "active" | "blocked";
  dailyRunLimit: number;
  maxFileBytes: number;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type BotTask = {
  id: number;
  type: "channel_membership";
  title: string;
  description: string | null;
  channelRef: string;
  joinUrl: string;
  enabled: boolean;
  createdByUserId: number;
  createdAt: Date;
  updatedAt: Date;
};

export type BotFile = {
  id: number;
  ownerUserId: number;
  chatId: number;
  filename: string;
  storagePath: string;
  telegramFileId: string | null;
  sizeBytes: number;
  sha256: string | null;
  runCount: number;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BotMessage = {
  id: number;
  userId: number;
  chatId: number;
  telegramMessageId: number | null;
  direction: "incoming" | "outgoing";
  kind: string;
  text: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

export type BotAuditLog = {
  id: number;
  actorUserId: number | null;
  action: string;
  targetUserId: number | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
};

type SqlValue = string | number | bigint | Uint8Array | null;
type SqlRow = Record<string, unknown>;

const dataDirectory =
  process.env["DATA_DIR"] ??
  (process.env["RAILWAY_ENVIRONMENT_ID"] ||
  process.env["RAILWAY_SERVICE_ID"] ||
  process.env["RAILWAY_PROJECT_ID"]
    ? "/data"
    : join(process.cwd(), "data"));
const databasePath =
  process.env["SQLITE_PATH"] ?? join(dataDirectory, "telegram-bot.sqlite");

mkdirSync(dirname(databasePath), { recursive: true });

export function getUserStorageDirectory(userId: number): string {
  return join(dataDirectory, "users", String(userId));
}

const sqlite = new DatabaseSync(databasePath);
sqlite.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS bot_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id INTEGER NOT NULL UNIQUE,
    telegram_chat_id INTEGER NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'blocked')),
    daily_run_limit INTEGER NOT NULL DEFAULT 20,
    max_file_bytes INTEGER NOT NULL DEFAULT 5242880,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS bot_users_status_idx ON bot_users(status);

  CREATE TABLE IF NOT EXISTS bot_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by_user_id INTEGER,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bot_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'channel_membership' CHECK (type = 'channel_membership'),
    title TEXT NOT NULL,
    description TEXT,
    channel_ref TEXT NOT NULL,
    join_url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_by_user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS bot_tasks_enabled_idx ON bot_tasks(enabled);

  CREATE TABLE IF NOT EXISTS bot_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    telegram_file_id TEXT,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT,
    run_count INTEGER NOT NULL DEFAULT 0,
    last_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(owner_user_id, filename)
  );

  CREATE INDEX IF NOT EXISTS bot_files_owner_idx ON bot_files(owner_user_id);

  CREATE TABLE IF NOT EXISTS bot_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    telegram_message_id INTEGER,
    direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
    kind TEXT NOT NULL,
    text TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS bot_messages_user_created_idx
    ON bot_messages(user_id, created_at);

  CREATE TABLE IF NOT EXISTS bot_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER,
    action TEXT NOT NULL,
    target_user_id INTEGER,
    details TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS bot_audit_logs_created_idx
    ON bot_audit_logs(created_at);
`);

function nowIso(): string {
  return new Date().toISOString();
}

function toDate(value: unknown): Date {
  const text = String(value);
  const date = new Date(text.includes("T") ? text : `${text.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function jsonParse(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function jsonStringify(value: Record<string, unknown> | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

function rows<T>(sql: string, values: SqlValue[] = []): T[] {
  return sqlite.prepare(sql).all(...values) as unknown as T[];
}

function one<T>(sql: string, values: SqlValue[] = []): T | undefined {
  return sqlite.prepare(sql).get(...values) as T | undefined;
}

function run(sql: string, values: SqlValue[] = []): void {
  sqlite.prepare(sql).run(...values);
}

function mapUser(row: SqlRow): BotUser {
  return {
    id: Number(row["id"]),
    telegramUserId: Number(row["telegram_user_id"]),
    telegramChatId: Number(row["telegram_chat_id"]),
    username: (row["username"] as string | null) ?? null,
    firstName: (row["first_name"] as string | null) ?? null,
    lastName: (row["last_name"] as string | null) ?? null,
    role: row["role"] as BotUser["role"],
    status: row["status"] as BotUser["status"],
    dailyRunLimit: Number(row["daily_run_limit"]),
    maxFileBytes: Number(row["max_file_bytes"]),
    lastSeenAt: toDate(row["last_seen_at"]),
    createdAt: toDate(row["created_at"]),
    updatedAt: toDate(row["updated_at"]),
  };
}

function mapTask(row: SqlRow): BotTask {
  return {
    id: Number(row["id"]),
    type: "channel_membership",
    title: String(row["title"]),
    description: (row["description"] as string | null) ?? null,
    channelRef: String(row["channel_ref"]),
    joinUrl: String(row["join_url"]),
    enabled: Boolean(row["enabled"]),
    createdByUserId: Number(row["created_by_user_id"]),
    createdAt: toDate(row["created_at"]),
    updatedAt: toDate(row["updated_at"]),
  };
}

function mapFile(row: SqlRow): BotFile {
  return {
    id: Number(row["id"]),
    ownerUserId: Number(row["owner_user_id"]),
    chatId: Number(row["chat_id"]),
    filename: String(row["filename"]),
    storagePath: String(row["storage_path"]),
    telegramFileId: (row["telegram_file_id"] as string | null) ?? null,
    sizeBytes: Number(row["size_bytes"]),
    sha256: (row["sha256"] as string | null) ?? null,
    runCount: Number(row["run_count"]),
    lastRunAt: row["last_run_at"] ? toDate(row["last_run_at"]) : null,
    createdAt: toDate(row["created_at"]),
    updatedAt: toDate(row["updated_at"]),
  };
}

function mapMessage(row: SqlRow): BotMessage {
  return {
    id: Number(row["id"]),
    userId: Number(row["user_id"]),
    chatId: Number(row["chat_id"]),
    telegramMessageId: row["telegram_message_id"]
      ? Number(row["telegram_message_id"])
      : null,
    direction: row["direction"] as BotMessage["direction"],
    kind: String(row["kind"]),
    text: (row["text"] as string | null) ?? null,
    metadata: jsonParse(row["metadata"]),
    createdAt: toDate(row["created_at"]),
  };
}

function mapAudit(row: SqlRow): BotAuditLog {
  return {
    id: Number(row["id"]),
    actorUserId: row["actor_user_id"] ? Number(row["actor_user_id"]) : null,
    action: String(row["action"]),
    targetUserId: row["target_user_id"] ? Number(row["target_user_id"]) : null,
    details: jsonParse(row["details"]),
    createdAt: toDate(row["created_at"]),
  };
}

export async function upsertTelegramUser(
  profile: {
    userId: number;
    chatId: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  },
  adminIds: Set<string>,
): Promise<BotUser> {
  const current = one<SqlRow>(
    "SELECT * FROM bot_users WHERE telegram_user_id = ?",
    [profile.userId],
  );
  const now = nowIso();
  const admin = adminIds.has(String(profile.userId));

  if (current) {
    run(
      `UPDATE bot_users
       SET telegram_chat_id = ?, username = ?, first_name = ?, last_name = ?,
           last_seen_at = ?, updated_at = ?,
           role = CASE WHEN ? = 1 THEN 'admin' ELSE role END,
           status = CASE WHEN ? = 1 THEN 'active' ELSE status END
       WHERE id = ?`,
      [
        profile.chatId,
        profile.username ?? null,
        profile.firstName ?? null,
        profile.lastName ?? null,
        now,
        now,
        admin ? 1 : 0,
        admin ? 1 : 0,
        Number(current["id"]),
      ],
    );
    return mapUser(
      one<SqlRow>("SELECT * FROM bot_users WHERE id = ?", [
        Number(current["id"]),
      ]) as SqlRow,
    );
  }

  const result = sqlite
    .prepare(
      `INSERT INTO bot_users (
        telegram_user_id, telegram_chat_id, username, first_name, last_name,
        role, status, daily_run_limit, max_file_bytes,
        last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 20, 5242880, ?, ?, ?)`,
    )
    .run(
      profile.userId,
      profile.chatId,
      profile.username ?? null,
      profile.firstName ?? null,
      profile.lastName ?? null,
      admin ? "admin" : "user",
      admin ? "active" : "pending",
      now,
      now,
      now,
    );
  return mapUser(
    one<SqlRow>("SELECT * FROM bot_users WHERE id = ?", [
      Number(result.lastInsertRowid),
    ]) as SqlRow,
  );
}

export async function getBotUserById(id: number): Promise<BotUser | undefined> {
  const result = one<SqlRow>("SELECT * FROM bot_users WHERE id = ?", [id]);
  return result ? mapUser(result) : undefined;
}

export async function getBotUserByTelegramId(
  telegramUserId: number,
): Promise<BotUser | undefined> {
  const result = one<SqlRow>("SELECT * FROM bot_users WHERE telegram_user_id = ?", [
    telegramUserId,
  ]);
  return result ? mapUser(result) : undefined;
}

export async function listBotUsers(limit = 30): Promise<BotUser[]> {
  return rows<SqlRow>(
    "SELECT * FROM bot_users ORDER BY last_seen_at DESC LIMIT ?",
    [limit],
  ).map(mapUser);
}

export async function listUsersByStatus(
  status: BotUser["status"],
  limit = 30,
): Promise<BotUser[]> {
  return rows<SqlRow>(
    "SELECT * FROM bot_users WHERE status = ? ORDER BY last_seen_at DESC LIMIT ?",
    [status, limit],
  ).map(mapUser);
}

export async function updateUserStatus(
  id: number,
  status: BotUser["status"],
): Promise<BotUser | undefined> {
  run("UPDATE bot_users SET status = ?, updated_at = ? WHERE id = ?", [
    status,
    nowIso(),
    id,
  ]);
  return getBotUserById(id);
}

export async function updateUserRole(
  id: number,
  role: BotUser["role"],
): Promise<BotUser | undefined> {
  run("UPDATE bot_users SET role = ?, updated_at = ? WHERE id = ?", [
    role,
    nowIso(),
    id,
  ]);
  return getBotUserById(id);
}

export async function updateUserLimits(
  id: number,
  values: { dailyRunLimit?: number; maxFileBytes?: number },
): Promise<BotUser | undefined> {
  if (values.dailyRunLimit !== undefined) {
    run(
      "UPDATE bot_users SET daily_run_limit = ?, updated_at = ? WHERE id = ?",
      [values.dailyRunLimit, nowIso(), id],
    );
  }
  if (values.maxFileBytes !== undefined) {
    run(
      "UPDATE bot_users SET max_file_bytes = ?, updated_at = ? WHERE id = ?",
      [values.maxFileBytes, nowIso(), id],
    );
  }
  return getBotUserById(id);
}

export async function getSetting(key: string, fallback: string): Promise<string> {
  const result = one<SqlRow>("SELECT value FROM bot_settings WHERE key = ?", [key]);
  return result ? String(result["value"]) : fallback;
}

export async function setSetting(
  key: string,
  value: string,
  updatedByUserId?: number,
): Promise<void> {
  run(
    `INSERT INTO bot_settings (key, value, updated_by_user_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_at = excluded.updated_at`,
    [key, value, updatedByUserId ?? null, nowIso()],
  );
}

export async function listBotTasks(enabledOnly = false): Promise<BotTask[]> {
  const query = enabledOnly
    ? "SELECT * FROM bot_tasks WHERE enabled = 1 ORDER BY id ASC"
    : "SELECT * FROM bot_tasks ORDER BY id ASC";
  return rows<SqlRow>(query).map(mapTask);
}

export async function createChannelTask(values: {
  title: string;
  description?: string;
  channelRef: string;
  joinUrl: string;
  createdByUserId: number;
}): Promise<BotTask> {
  const now = nowIso();
  const result = sqlite
    .prepare(
      `INSERT INTO bot_tasks (
        type, title, description, channel_ref, join_url, enabled,
        created_by_user_id, created_at, updated_at
      ) VALUES ('channel_membership', ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      values.title,
      values.description ?? null,
      values.channelRef,
      values.joinUrl,
      values.createdByUserId,
      now,
      now,
    );
  const task = one<SqlRow>("SELECT * FROM bot_tasks WHERE id = ?", [
    Number(result.lastInsertRowid),
  ]);
  if (!task) {
    throw new Error("Görev oluşturulamadı.");
  }
  return mapTask(task);
}

export async function setTaskEnabled(
  id: number,
  enabled: boolean,
): Promise<BotTask | undefined> {
  run("UPDATE bot_tasks SET enabled = ?, updated_at = ? WHERE id = ?", [
    enabled ? 1 : 0,
    nowIso(),
    id,
  ]);
  const task = one<SqlRow>("SELECT * FROM bot_tasks WHERE id = ?", [id]);
  return task ? mapTask(task) : undefined;
}

export async function deleteTask(id: number): Promise<void> {
  run("DELETE FROM bot_tasks WHERE id = ?", [id]);
}

export async function upsertBotFile(values: {
  ownerUserId: number;
  chatId: number;
  filename: string;
  storagePath: string;
  telegramFileId: string;
  sizeBytes: number;
  sha256: string;
}): Promise<BotFile> {
  const current = one<SqlRow>(
    "SELECT id FROM bot_files WHERE owner_user_id = ? AND filename = ?",
    [values.ownerUserId, values.filename],
  );
  const now = nowIso();
  if (current) {
    run(
      `UPDATE bot_files SET chat_id = ?, storage_path = ?, telegram_file_id = ?,
       size_bytes = ?, sha256 = ?, updated_at = ? WHERE id = ?`,
      [
        values.chatId,
        values.storagePath,
        values.telegramFileId,
        values.sizeBytes,
        values.sha256,
        now,
        Number(current["id"]),
      ],
    );
    return mapFile(
      one<SqlRow>("SELECT * FROM bot_files WHERE id = ?", [
        Number(current["id"]),
      ]) as SqlRow,
    );
  }

  const result = sqlite
    .prepare(
      `INSERT INTO bot_files (
        owner_user_id, chat_id, filename, storage_path, telegram_file_id,
        size_bytes, sha256, run_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      values.ownerUserId,
      values.chatId,
      values.filename,
      values.storagePath,
      values.telegramFileId,
      values.sizeBytes,
      values.sha256,
      now,
      now,
    );
  return mapFile(
    one<SqlRow>("SELECT * FROM bot_files WHERE id = ?", [
      Number(result.lastInsertRowid),
    ]) as SqlRow,
  );
}

export async function listBotFiles(
  ownerUserId: number,
  limit = 50,
): Promise<BotFile[]> {
  return rows<SqlRow>(
    "SELECT * FROM bot_files WHERE owner_user_id = ? ORDER BY updated_at DESC LIMIT ?",
    [ownerUserId, limit],
  ).map(mapFile);
}

export async function getBotFile(
  id: number,
  ownerUserId?: number,
): Promise<BotFile | undefined> {
  const result =
    ownerUserId === undefined
      ? one<SqlRow>("SELECT * FROM bot_files WHERE id = ?", [id])
      : one<SqlRow>(
          "SELECT * FROM bot_files WHERE id = ? AND owner_user_id = ?",
          [id, ownerUserId],
        );
  return result ? mapFile(result) : undefined;
}

export async function deleteBotFile(id: number): Promise<void> {
  run("DELETE FROM bot_files WHERE id = ?", [id]);
}

export async function markFileRun(id: number): Promise<void> {
  run(
    `UPDATE bot_files
     SET run_count = run_count + 1, last_run_at = ?, updated_at = ?
     WHERE id = ?`,
    [nowIso(), nowIso(), id],
  );
}

export async function recordMessage(values: {
  userId: number;
  chatId: number;
  telegramMessageId?: number;
  direction: "incoming" | "outgoing";
  kind: string;
  text?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  run(
    `INSERT INTO bot_messages (
      user_id, chat_id, telegram_message_id, direction, kind, text, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      values.userId,
      values.chatId,
      values.telegramMessageId ?? null,
      values.direction,
      values.kind,
      values.text ?? null,
      jsonStringify(values.metadata),
      nowIso(),
    ],
  );
}

export async function listUserMessages(
  userId: number,
  limit = 25,
): Promise<BotMessage[]> {
  return rows<SqlRow>(
    "SELECT * FROM bot_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    [userId, limit],
  ).map(mapMessage);
}

export async function recordAudit(values: {
  actorUserId?: number;
  action: string;
  targetUserId?: number;
  details?: Record<string, unknown>;
}): Promise<void> {
  run(
    `INSERT INTO bot_audit_logs (
      actor_user_id, action, target_user_id, details, created_at
    ) VALUES (?, ?, ?, ?, ?)`,
    [
      values.actorUserId ?? null,
      values.action,
      values.targetUserId ?? null,
      jsonStringify(values.details),
      nowIso(),
    ],
  );
}

export async function listAuditLogs(limit = 25): Promise<BotAuditLog[]> {
  return rows<SqlRow>(
    "SELECT * FROM bot_audit_logs ORDER BY created_at DESC LIMIT ?",
    [limit],
  ).map(mapAudit);
}

export async function countRunsSince(
  userId: number,
  since: Date,
): Promise<number> {
  const result = one<SqlRow>(
    `SELECT COUNT(*) AS total FROM bot_audit_logs
     WHERE actor_user_id = ? AND action = 'file_run' AND created_at >= ?`,
    [userId, since.toISOString()],
  );
  return Number(result?.["total"] ?? 0);
}

export async function getBotStats(): Promise<{
  users: number;
  activeUsers: number;
  files: number;
  messages: number;
  runs: number;
}> {
  const users = one<SqlRow>("SELECT COUNT(*) AS total FROM bot_users");
  const activeUsers = one<SqlRow>(
    "SELECT COUNT(*) AS total FROM bot_users WHERE status = 'active'",
  );
  const files = one<SqlRow>("SELECT COUNT(*) AS total FROM bot_files");
  const messages = one<SqlRow>("SELECT COUNT(*) AS total FROM bot_messages");
  const runs = one<SqlRow>(
    "SELECT COUNT(*) AS total FROM bot_audit_logs WHERE action = 'file_run'",
  );
  return {
    users: Number(users?.["total"] ?? 0),
    activeUsers: Number(activeUsers?.["total"] ?? 0),
    files: Number(files?.["total"] ?? 0),
    messages: Number(messages?.["total"] ?? 0),
    runs: Number(runs?.["total"] ?? 0),
  };
}