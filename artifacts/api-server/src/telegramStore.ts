import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  sql,
} from "drizzle-orm";
import {
  botAuditLogsTable,
  botFilesTable,
  botMessagesTable,
  botSettingsTable,
  botTasksTable,
  botUsersTable,
  type BotFile,
  type BotTask,
  type BotUser,
} from "@workspace/db";
import { db } from "@workspace/db";

type TelegramProfile = {
  userId: number;
  chatId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
};

export async function upsertTelegramUser(
  profile: TelegramProfile,
  adminIds: Set<string>,
): Promise<BotUser> {
  const admin = adminIds.has(String(profile.userId));
  const existing = await db
    .select()
    .from(botUsersTable)
    .where(eq(botUsersTable.telegramUserId, profile.userId))
    .limit(1);

  if (existing[0]) {
    const [updated] = await db
      .update(botUsersTable)
      .set({
        telegramChatId: profile.chatId,
        username: profile.username ?? null,
        firstName: profile.firstName ?? null,
        lastName: profile.lastName ?? null,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
        ...(admin ? { role: "admin" as const, status: "active" as const } : {}),
      })
      .where(eq(botUsersTable.id, existing[0].id))
      .returning();
    return updated ?? existing[0];
  }

  const [created] = await db
    .insert(botUsersTable)
    .values({
      telegramUserId: profile.userId,
      telegramChatId: profile.chatId,
      username: profile.username ?? null,
      firstName: profile.firstName ?? null,
      lastName: profile.lastName ?? null,
      role: admin ? "admin" : "user",
      status: admin ? "active" : "pending",
    })
    .returning();
  if (!created) {
    throw new Error("Telegram kullanıcısı oluşturulamadı.");
  }
  return created;
}

export async function getBotUserById(id: number): Promise<BotUser | undefined> {
  const [user] = await db
    .select()
    .from(botUsersTable)
    .where(eq(botUsersTable.id, id))
    .limit(1);
  return user;
}

export async function getBotUserByTelegramId(
  telegramUserId: number,
): Promise<BotUser | undefined> {
  const [user] = await db
    .select()
    .from(botUsersTable)
    .where(eq(botUsersTable.telegramUserId, telegramUserId))
    .limit(1);
  return user;
}

export async function listBotUsers(limit = 30): Promise<BotUser[]> {
  return db
    .select()
    .from(botUsersTable)
    .orderBy(desc(botUsersTable.lastSeenAt))
    .limit(limit);
}

export async function listUsersByStatus(
  status: BotUser["status"],
  limit = 30,
): Promise<BotUser[]> {
  return db
    .select()
    .from(botUsersTable)
    .where(eq(botUsersTable.status, status))
    .orderBy(desc(botUsersTable.lastSeenAt))
    .limit(limit);
}

export async function updateUserStatus(
  id: number,
  status: BotUser["status"],
): Promise<BotUser | undefined> {
  const [updated] = await db
    .update(botUsersTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(botUsersTable.id, id))
    .returning();
  return updated;
}

export async function updateUserRole(
  id: number,
  role: BotUser["role"],
): Promise<BotUser | undefined> {
  const [updated] = await db
    .update(botUsersTable)
    .set({ role, updatedAt: new Date() })
    .where(eq(botUsersTable.id, id))
    .returning();
  return updated;
}

export async function updateUserLimits(
  id: number,
  values: { dailyRunLimit?: number; maxFileBytes?: number },
): Promise<BotUser | undefined> {
  const [updated] = await db
    .update(botUsersTable)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(botUsersTable.id, id))
    .returning();
  return updated;
}

export async function getSetting(
  key: string,
  fallback: string,
): Promise<string> {
  const [setting] = await db
    .select()
    .from(botSettingsTable)
    .where(eq(botSettingsTable.key, key))
    .limit(1);
  return setting?.value ?? fallback;
}

export async function setSetting(
  key: string,
  value: string,
  updatedByUserId?: number,
): Promise<void> {
  await db
    .insert(botSettingsTable)
    .values({
      key,
      value,
      updatedByUserId: updatedByUserId ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: botSettingsTable.key,
      set: { value, updatedByUserId, updatedAt: new Date() },
    });
}

export async function listBotTasks(enabledOnly = false): Promise<BotTask[]> {
  return db
    .select()
    .from(botTasksTable)
    .where(enabledOnly ? eq(botTasksTable.enabled, true) : undefined)
    .orderBy(asc(botTasksTable.id));
}

export async function createChannelTask(values: {
  title: string;
  description?: string;
  channelRef: string;
  joinUrl: string;
  createdByUserId: number;
}): Promise<BotTask> {
  const [task] = await db
    .insert(botTasksTable)
    .values({
      type: "channel_membership",
      title: values.title,
      description: values.description ?? null,
      channelRef: values.channelRef,
      joinUrl: values.joinUrl,
      createdByUserId: values.createdByUserId,
    })
    .returning();
  if (!task) {
    throw new Error("Görev oluşturulamadı.");
  }
  return task;
}

export async function setTaskEnabled(
  id: number,
  enabled: boolean,
): Promise<BotTask | undefined> {
  const [task] = await db
    .update(botTasksTable)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(botTasksTable.id, id))
    .returning();
  return task;
}

export async function deleteTask(id: number): Promise<void> {
  await db.delete(botTasksTable).where(eq(botTasksTable.id, id));
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
  const [file] = await db
    .insert(botFilesTable)
    .values(values)
    .onConflictDoUpdate({
      target: [botFilesTable.ownerUserId, botFilesTable.filename],
      set: {
        chatId: values.chatId,
        storagePath: values.storagePath,
        telegramFileId: values.telegramFileId,
        sizeBytes: values.sizeBytes,
        sha256: values.sha256,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!file) {
    throw new Error("Dosya kaydı oluşturulamadı.");
  }
  return file;
}

export async function listBotFiles(
  ownerUserId: number,
  limit = 50,
): Promise<BotFile[]> {
  return db
    .select()
    .from(botFilesTable)
    .where(eq(botFilesTable.ownerUserId, ownerUserId))
    .orderBy(desc(botFilesTable.updatedAt))
    .limit(limit);
}

export async function getBotFile(
  id: number,
  ownerUserId?: number,
): Promise<BotFile | undefined> {
  const conditions = [eq(botFilesTable.id, id)];
  if (ownerUserId !== undefined) {
    conditions.push(eq(botFilesTable.ownerUserId, ownerUserId));
  }
  const [file] = await db
    .select()
    .from(botFilesTable)
    .where(and(...conditions))
    .limit(1);
  return file;
}

export async function deleteBotFile(id: number): Promise<void> {
  await db.delete(botFilesTable).where(eq(botFilesTable.id, id));
}

export async function markFileRun(id: number): Promise<void> {
  await db
    .update(botFilesTable)
    .set({
      runCount: sql`${botFilesTable.runCount} + 1`,
      lastRunAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(botFilesTable.id, id));
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
  await db.insert(botMessagesTable).values({
    userId: values.userId,
    chatId: values.chatId,
    telegramMessageId: values.telegramMessageId ?? null,
    direction: values.direction,
    kind: values.kind,
    text: values.text ?? null,
    metadata: values.metadata ?? null,
  });
}

export async function listUserMessages(
  userId: number,
  limit = 25,
): Promise<typeof botMessagesTable.$inferSelect[]> {
  return db
    .select()
    .from(botMessagesTable)
    .where(eq(botMessagesTable.userId, userId))
    .orderBy(desc(botMessagesTable.createdAt))
    .limit(limit);
}

export async function recordAudit(values: {
  actorUserId?: number;
  action: string;
  targetUserId?: number;
  details?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(botAuditLogsTable).values({
    actorUserId: values.actorUserId ?? null,
    action: values.action,
    targetUserId: values.targetUserId ?? null,
    details: values.details ?? null,
  });
}

export async function countRunsSince(
  userId: number,
  since: Date,
): Promise<number> {
  const [result] = await db
    .select({ total: count() })
    .from(botAuditLogsTable)
    .where(
      and(
        eq(botAuditLogsTable.actorUserId, userId),
        eq(botAuditLogsTable.action, "file_run"),
        gte(botAuditLogsTable.createdAt, since),
      ),
    );
  return Number(result?.total ?? 0);
}

export async function getBotStats(): Promise<{
  users: number;
  activeUsers: number;
  files: number;
  messages: number;
  runs: number;
}> {
  const [users, activeUsers, files, messages, runs] = await Promise.all([
    db.select({ total: count() }).from(botUsersTable),
    db
      .select({ total: count() })
      .from(botUsersTable)
      .where(eq(botUsersTable.status, "active")),
    db.select({ total: count() }).from(botFilesTable),
    db.select({ total: count() }).from(botMessagesTable),
    db
      .select({ total: count() })
      .from(botAuditLogsTable)
      .where(eq(botAuditLogsTable.action, "file_run")),
  ]);

  return {
    users: Number(users[0]?.total ?? 0),
    activeUsers: Number(activeUsers[0]?.total ?? 0),
    files: Number(files[0]?.total ?? 0),
    messages: Number(messages[0]?.total ?? 0),
    runs: Number(runs[0]?.total ?? 0),
  };
}