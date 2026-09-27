import { createInsertSchema } from "drizzle-zod";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const botUserStatusEnum = pgEnum("bot_user_status", [
  "pending",
  "active",
  "blocked",
]);

export const botUserRoleEnum = pgEnum("bot_user_role", ["user", "admin"]);

export const botAccessModeEnum = pgEnum("bot_access_mode", [
  "open",
  "approval",
  "closed",
]);

export const taskTypeEnum = pgEnum("bot_task_type", ["channel_membership"]);

export const messageDirectionEnum = pgEnum("bot_message_direction", [
  "incoming",
  "outgoing",
]);

export const botUsersTable = pgTable(
  "bot_users",
  {
    id: serial("id").primaryKey(),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
    username: varchar("username", { length: 255 }),
    firstName: varchar("first_name", { length: 255 }),
    lastName: varchar("last_name", { length: 255 }),
    role: botUserRoleEnum("role").notNull().default("user"),
    status: botUserStatusEnum("status").notNull().default("pending"),
    dailyRunLimit: integer("daily_run_limit").notNull().default(20),
    maxFileBytes: integer("max_file_bytes").notNull().default(5 * 1024 * 1024),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("bot_users_telegram_user_id_idx").on(table.telegramUserId),
    index("bot_users_status_idx").on(table.status),
  ],
);

export const botSettingsTable = pgTable("bot_settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: text("value").notNull(),
  updatedByUserId: integer("updated_by_user_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const botTasksTable = pgTable(
  "bot_tasks",
  {
    id: serial("id").primaryKey(),
    type: taskTypeEnum("type").notNull().default("channel_membership"),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    channelRef: varchar("channel_ref", { length: 255 }).notNull(),
    joinUrl: varchar("join_url", { length: 1000 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: integer("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("bot_tasks_enabled_idx").on(table.enabled)],
);

export const botFilesTable = pgTable(
  "bot_files",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id").notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    filename: varchar("filename", { length: 120 }).notNull(),
    storagePath: text("storage_path").notNull(),
    telegramFileId: varchar("telegram_file_id", { length: 255 }),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }),
    runCount: integer("run_count").notNull().default(0),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("bot_files_owner_filename_idx").on(
      table.ownerUserId,
      table.filename,
    ),
    index("bot_files_owner_idx").on(table.ownerUserId),
  ],
);

export const botMessagesTable = pgTable(
  "bot_messages",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    telegramMessageId: integer("telegram_message_id"),
    direction: messageDirectionEnum("direction").notNull(),
    kind: varchar("kind", { length: 50 }).notNull(),
    text: text("text"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("bot_messages_user_created_idx").on(table.userId, table.createdAt),
    index("bot_messages_chat_created_idx").on(table.chatId, table.createdAt),
  ],
);

export const botAuditLogsTable = pgTable(
  "bot_audit_logs",
  {
    id: serial("id").primaryKey(),
    actorUserId: integer("actor_user_id"),
    action: varchar("action", { length: 100 }).notNull(),
    targetUserId: integer("target_user_id"),
    details: jsonb("details").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("bot_audit_logs_created_idx").on(table.createdAt)],
);

export const insertBotUserSchema = createInsertSchema(botUsersTable);
export const insertBotSettingSchema = createInsertSchema(botSettingsTable);
export const insertBotTaskSchema = createInsertSchema(botTasksTable);
export const insertBotFileSchema = createInsertSchema(botFilesTable);
export const insertBotMessageSchema = createInsertSchema(botMessagesTable);
export const insertBotAuditLogSchema = createInsertSchema(botAuditLogsTable);

export type BotUser = typeof botUsersTable.$inferSelect;
export type BotTask = typeof botTasksTable.$inferSelect;
export type BotFile = typeof botFilesTable.$inferSelect;
export type BotMessage = typeof botMessagesTable.$inferSelect;