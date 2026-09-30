import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { logger } from "./lib/logger";
import {
  type BotFile,
  type BotTask,
  type BotUser,
  countRunsSince,
  createChannelTask,
  deleteBotFile,
  deleteTask,
  getBotFile,
  getBotStats,
  getBotUserById,
  getBotUserByTelegramId,
  getUserStorageDirectory,
  getSetting,
  listBotFiles,
  listAuditLogs,
  listBotTasks,
  listBotUsers,
  listUserMessages,
  listUsersByStatus,
  markFileRun,
  recordAudit,
  recordMessage,
  setSetting,
  setTaskEnabled,
  updateUserLimits,
  updateUserRole,
  updateUserStatus,
  upsertBotFile,
  upsertTelegramUser,
} from "./telegramStore";

const MAX_OUTPUT_BYTES = 12_000;
const SCRIPT_TIMEOUT_MS = 20_000;
const POLL_TIMEOUT_SECONDS = 25;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const ADMIN_TELEGRAM_IDS = new Set(["8916044522"]);

type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramChat = {
  id: number;
};

type TelegramDocument = {
  file_id: string;
  file_name?: string;
  file_size?: number;
};

type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  document?: TelegramDocument;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramFile = {
  file_path?: string;
};

type TelegramMember = {
  status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
};

type TelegramResponse<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

type InlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

type InlineKeyboard = {
  inline_keyboard: InlineButton[][];
};

type RunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
};

type BotContext = {
  token: string;
  adminIds: Set<string>;
};

function normalizeFilename(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const filename = basename(value).replace(/[^a-zA-Z0-9._-]/g, "_");
  if (
    !filename ||
    filename.startsWith(".") ||
    filename.length > 120 ||
    extname(filename).toLowerCase() !== ".py"
  ) {
    return null;
  }
  return filename;
}

function userDirectory(userId: number): string {
  return getUserStorageDirectory(userId);
}

function storagePathFor(userId: number, filename: string): string {
  return join(userDirectory(userId), filename);
}

function displayName(user: BotUser): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return name || user.username || String(user.telegramUserId);
}

function formatDate(value: Date | null | undefined): string {
  if (!value) {
    return "—";
  }
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Istanbul",
  }).format(value);
}

function statusLabel(status: BotUser["status"]): string {
  return status === "active"
    ? "Aktif"
    : status === "blocked"
      ? "Yasaklı"
      : "Onay bekliyor";
}

function roleLabel(role: BotUser["role"]): string {
  return role === "admin" ? "Yönetici" : "Kullanıcı";
}

async function telegramRequest<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  timeoutMs = 35_000,
): Promise<TelegramResponse<T>> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = (await response.json()) as TelegramResponse<T>;
  if (!response.ok || !payload.ok) {
    throw new Error(
      `Telegram API ${method} failed: ${payload.description ?? response.statusText}`,
    );
  }
  return payload;
}

async function sendMessage(
  context: BotContext,
  chatId: number,
  text: string,
  userId?: number,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  const chunks = text.match(/[\s\S]{1,3900}/g) ?? [text];
  for (const [index, chunk] of chunks.entries()) {
    const response = await telegramRequest<{ message_id: number }>(
      context.token,
      "sendMessage",
      {
        chat_id: chatId,
        text: chunk,
        ...(index === 0 && replyMarkup ? { reply_markup: replyMarkup } : {}),
      },
    );
    if (userId) {
      await recordMessage({
        userId,
        chatId,
        telegramMessageId: response.result.message_id,
        direction: "outgoing",
        kind: "text",
        text: chunk,
      }).catch((error) => {
        logger.error({ err: error, userId }, "Giden mesaj geçmişe kaydedilemedi");
      });
    }
  }
}

async function answerCallback(context: BotContext, queryId: string): Promise<void> {
  await telegramRequest(context.token, "answerCallbackQuery", {
    callback_query_id: queryId,
  });
}

async function downloadTelegramFile(
  context: BotContext,
  fileId: string,
  destination: string,
): Promise<void> {
  const fileResponse = await telegramRequest<TelegramFile>(
    context.token,
    "getFile",
    { file_id: fileId },
  );
  if (!fileResponse.result.file_path) {
    throw new Error("Telegram dosya yolu döndürmedi.");
  }

  const response = await fetch(
    `https://api.telegram.org/file/bot${context.token}/${fileResponse.result.file_path}`,
    { signal: AbortSignal.timeout(35_000) },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Telegram dosyası indirilemedi: ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

async function runPythonFile(
  storagePath: string,
  workingDirectory: string,
): Promise<RunResult> {
  const chunks: Buffer[] = [];
  let outputBytes = 0;
  let timedOut = false;

  return new Promise((resolve) => {
    const child = spawn("python3", ["-u", storagePath], {
      cwd: workingDirectory,
      env: {
        HOME: workingDirectory,
        LANG: "C.UTF-8",
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        PYTHONNOUSERSITE: "1",
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const collect = (chunk: Buffer): void => {
      if (outputBytes >= MAX_OUTPUT_BYTES) {
        return;
      }
      const kept = chunk.subarray(0, MAX_OUTPUT_BYTES - outputBytes);
      chunks.push(kept);
      outputBytes += kept.length;
      if (outputBytes >= MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
      }
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, SCRIPT_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        output: error.message,
        timedOut,
      });
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        output: Buffer.concat(chunks).toString("utf8"),
        timedOut,
      });
    });
  });
}

function formatRunResult(filename: string, result: RunResult): string {
  const output = result.output.trim() || "(çıktı yok)";
  const truncated =
    result.output.length >= MAX_OUTPUT_BYTES ? "\n\n[Çıktı kısaltıldı]" : "";

  if (result.timedOut) {
    return `⏱️ ${filename} 20 saniyelik çalışma süresini aştığı için durduruldu.\n\n${output}${truncated}`;
  }
  if (result.exitCode === 0) {
    return `✅ ${filename} tamamlandı.\n\n${output}${truncated}`;
  }
  return `❌ ${filename} hata ile sonlandı (kod: ${result.exitCode ?? "bilinmiyor"}${result.signal ? `, sinyal: ${result.signal}` : ""}).\n\n${output}${truncated}`;
}

function userPanelKeyboard(user: BotUser): InlineKeyboard {
  const rows: InlineButton[][] = [
    [
      { text: "Dosyalarım", callback_data: "user:files" },
      { text: "Mesaj geçmişim", callback_data: "user:history" },
    ],
    [
      { text: "Profil ve limitler", callback_data: "user:profile" },
      { text: "Görevleri kontrol et", callback_data: "user:check" },
    ],
    [{ text: "Yardım", callback_data: "user:help" }],
  ];
  if (user.role === "admin") {
    rows.push([{ text: "Yönetici paneli", callback_data: "admin:menu" }]);
  }
  return { inline_keyboard: rows };
}

function adminPanelKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "Genel durum", callback_data: "admin:stats" },
        { text: "Kullanıcılar", callback_data: "admin:users" },
      ],
      [
        { text: "Bekleyenler", callback_data: "admin:pending" },
        { text: "Erişim ayarları", callback_data: "admin:access" },
      ],
      [
        { text: "Kanal görevleri", callback_data: "admin:tasks" },
        { text: "Denetim kayıtları", callback_data: "admin:audit" },
      ],
      [{ text: "Kullanıcı komutları", callback_data: "admin:commands" }],
    ],
  };
}

function taskKeyboard(tasks: BotTask[]): InlineKeyboard | undefined {
  if (!tasks.length) {
    return undefined;
  }
  return {
    inline_keyboard: [
      ...tasks.map((task) => [
        { text: `Katıl: ${task.title}`, url: task.joinUrl },
      ]),
      [{ text: "Katılımı kontrol et", callback_data: "user:check" }],
    ],
  };
}

async function checkChannelTask(
  context: BotContext,
  task: BotTask,
  telegramUserId: number,
): Promise<"passed" | "failed" | "unavailable"> {
  try {
    const response = await telegramRequest<TelegramMember>(
      context.token,
      "getChatMember",
      { chat_id: task.channelRef, user_id: telegramUserId },
    );
    return ["creator", "administrator", "member"].includes(
      response.result.status,
    )
      ? "passed"
      : "failed";
  } catch (error) {
    logger.error({ err: error, taskId: task.id }, "Kanal görevi kontrol edilemedi");
    return "unavailable";
  }
}

async function accessState(
  context: BotContext,
  user: BotUser,
): Promise<{
  allowed: boolean;
  message: string;
  tasks: BotTask[];
}> {
  if (user.role === "admin" || context.adminIds.has(String(user.telegramUserId))) {
    return { allowed: true, message: "", tasks: [] };
  }

  if (user.status === "blocked") {
    return {
      allowed: false,
      message: "Bu botu kullanmanız yönetici tarafından engellendi.",
      tasks: [],
    };
  }

  const mode = await getSetting("access_mode", "open");
  if (mode === "closed") {
    return {
      allowed: false,
      message: "Bot şu anda kullanıma kapalı. Daha sonra tekrar deneyin.",
      tasks: [],
    };
  }

  if (mode === "approval" && user.status !== "active") {
    return {
      allowed: false,
      message:
        "Kullanım isteğiniz yönetici onayı bekliyor. Onaylandığında botu kullanabilirsiniz.",
      tasks: [],
    };
  }

  if (mode === "open" && user.status !== "active") {
    await updateUserStatus(user.id, "active");
  }

  const tasks = await listBotTasks(true);
  const results = await Promise.all(
    tasks.map((task) => checkChannelTask(context, task, user.telegramUserId)),
  );
  const failedTasks = tasks.filter((_, index) => results[index] !== "passed");
  if (failedTasks.length) {
    return {
      allowed: false,
      message:
        "Botu kullanmak için aşağıdaki görevleri tamamlayın. Kanal kontrolü için botun ilgili kanalda yönetici olması gerekir.",
      tasks: failedTasks,
    };
  }

  return { allowed: true, message: "", tasks: [] };
}

async function requireAccess(
  context: BotContext,
  user: BotUser,
  chatId: number,
): Promise<boolean> {
  const state = await accessState(context, user);
  if (state.allowed) {
    return true;
  }
  await sendMessage(
    context,
    chatId,
    state.message,
    user.id,
    taskKeyboard(state.tasks),
  );
  return false;
}

async function sendUserPanel(
  context: BotContext,
  user: BotUser,
  chatId: number,
): Promise<void> {
  const state = await accessState(context, user);
  if (!state.allowed) {
    await sendMessage(
      context,
      chatId,
      state.message,
      user.id,
      taskKeyboard(state.tasks),
    );
    return;
  }

  await sendMessage(
    context,
    chatId,
    `Kontrol paneliniz\n\nKullanıcı: ${displayName(user)}\nDurum: ${statusLabel(user.status)}`,
    user.id,
    userPanelKeyboard(user),
  );
}

async function sendAdminPanel(
  context: BotContext,
  user: BotUser,
  chatId: number,
): Promise<void> {
  if (user.role !== "admin") {
    await sendMessage(context, chatId, "Bu panel yalnızca yöneticilere açıktır.", user.id);
    return;
  }
  await sendMessage(
    context,
    chatId,
    "Yönetici kontrol paneli\n\nKullanıcı erişimi, görevler, geçmiş ve denetim kayıtlarını buradan yönetebilirsiniz.",
    user.id,
    adminPanelKeyboard(),
  );
}

async function sendUserFiles(
  context: BotContext,
  user: BotUser,
  chatId: number,
): Promise<void> {
  const files = await listBotFiles(user.id);
  if (!files.length) {
    await sendMessage(
      context,
      chatId,
      "Henüz kayıtlı dosyanız yok. Bir .py dosyası gönderdiğinizde kaydedilip otomatik çalıştırılır.",
      user.id,
      userPanelKeyboard(user),
    );
    return;
  }

  const rows: InlineButton[][] = files.map((file) => [
    {
      text: `${file.filename} (${Math.ceil(file.sizeBytes / 1024)} KB)`,
      callback_data: `user:file:view:${file.id}`,
    },
  ]);
  rows.push([{ text: "Panele dön", callback_data: "user:panel" }]);
  await sendMessage(
    context,
    chatId,
    `Dosyalarınız (${files.length})\n\nHer dosyayı seçerek çalıştırabilir, detayını görebilir veya silebilirsiniz.`,
    user.id,
    { inline_keyboard: rows },
  );
}

async function sendUserHistory(
  context: BotContext,
  user: BotUser,
  chatId: number,
): Promise<void> {
  const messages = await listUserMessages(user.id, 20);
  if (!messages.length) {
    await sendMessage(context, chatId, "Henüz mesaj geçmişiniz yok.", user.id);
    return;
  }
  const lines = messages
    .reverse()
    .map(
      (message) =>
        `${formatDate(message.createdAt)} | ${message.direction === "incoming" ? "Gelen" : "Bot"} | ${message.text?.slice(0, 180) ?? `[${message.kind}]`}`,
    );
  await sendMessage(context, chatId, `Son mesajlarınız:\n\n${lines.join("\n")}`, user.id);
}

async function sendUserProfile(
  context: BotContext,
  user: BotUser,
  chatId: number,
): Promise<void> {
  const mode = await getSetting("access_mode", "open");
  await sendMessage(
    context,
    chatId,
    [
      "Profil ve limitler",
      "",
      `Ad: ${displayName(user)}`,
      `Telegram ID: ${user.telegramUserId}`,
      `Rol: ${roleLabel(user.role)}`,
      `Durum: ${statusLabel(user.status)}`,
      `Günlük çalıştırma limiti: ${user.dailyRunLimit}`,
      `Maksimum dosya boyutu: ${Math.floor(user.maxFileBytes / 1024 / 1024)} MB`,
      `Genel erişim modu: ${mode}`,
      `Son görülme: ${formatDate(user.lastSeenAt)}`,
    ].join("\n"),
    user.id,
    userPanelKeyboard(user),
  );
}

async function runStoredFile(
  context: BotContext,
  user: BotUser,
  file: BotFile,
  chatId: number,
): Promise<void> {
  if (user.role !== "admin") {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const used = await countRunsSince(user.id, startOfDay);
    if (used >= user.dailyRunLimit) {
      await sendMessage(
        context,
        chatId,
        `Günlük çalıştırma limitinize ulaştınız (${user.dailyRunLimit}).`,
        user.id,
      );
      return;
    }
  }

  await sendMessage(context, chatId, `▶️ ${file.filename} çalıştırılıyor...`, user.id);
  const result = await runPythonFile(file.storagePath, userDirectory(user.id));
  await markFileRun(file.id);
  await recordAudit({
    actorUserId: user.id,
    action: "file_run",
    targetUserId: user.id,
    details: {
      fileId: file.id,
      filename: file.filename,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    },
  });
  await sendMessage(
    context,
    chatId,
    formatRunResult(file.filename, result),
    user.id,
    userPanelKeyboard(user),
  );
}

async function handleDocument(
  context: BotContext,
  user: BotUser,
  message: TelegramMessage,
): Promise<void> {
  if (!(await requireAccess(context, user, message.chat.id))) {
    return;
  }

  const document = message.document;
  if (!document) {
    return;
  }
  const filename = normalizeFilename(document.file_name);
  if (!filename) {
    await sendMessage(
      context,
      message.chat.id,
      "Sadece .py uzantılı dosyalar kabul edilir. Dosya adını kontrol edin.",
      user.id,
    );
    return;
  }

  const maxBytes = Math.min(user.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  if (document.file_size !== undefined && document.file_size > maxBytes) {
    await sendMessage(
      context,
      message.chat.id,
      `Dosya çok büyük. Sizin limitiniz ${Math.floor(maxBytes / 1024 / 1024)} MB.`,
      user.id,
    );
    return;
  }

  const directory = userDirectory(user.id);
  await mkdir(directory, { recursive: true });
  const destination = storagePathFor(user.id, filename);

  try {
    await downloadTelegramFile(context, document.file_id, destination);
    const downloaded = await stat(destination);
    if (downloaded.size > maxBytes) {
      await rm(destination, { force: true });
      await sendMessage(context, message.chat.id, "Dosya boyut limitini aşıyor.", user.id);
      return;
    }

    const sha256 = createHash("sha256")
      .update(await readFile(destination))
      .digest("hex");
    const file = await upsertBotFile({
      ownerUserId: user.id,
      chatId: message.chat.id,
      filename,
      storagePath: destination,
      telegramFileId: document.file_id,
      sizeBytes: downloaded.size,
      sha256,
    });

    await sendMessage(
      context,
      message.chat.id,
      `📥 ${filename} kaydedildi. Otomatik çalıştırma başlıyor.`,
      user.id,
    );
    await runStoredFile(context, user, file, message.chat.id);
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    logger.error({ err: error, userId: user.id, filename }, "Dosya işlenemedi");
    await sendMessage(
      context,
      message.chat.id,
      "Dosya işlenirken bir hata oluştu. Yönetici kayıtlarını kontrol edebilir.",
      user.id,
    );
  }
}

async function sendAdminStats(
  context: BotContext,
  user: BotUser,
  chatId: number,
): Promise<void> {
  const stats = await getBotStats();
  const mode = await getSetting("access_mode", "open");
  await sendMessage(
    context,
    chatId,
    [
      "Genel durum",
      "",
      `Erişim modu: ${mode}`,
      `Toplam kullanıcı: ${stats.users}`,
      `Aktif kullanıcı: ${stats.activeUsers}`,
      `Toplam dosya: ${stats.files}`,
      `Toplam mesaj: ${stats.messages}`,
      `Toplam çalıştırma: ${stats.runs}`,
    ].join("\n"),
    user.id,
    adminPanelKeyboard(),
  );
}

async function sendAdminUsers(
  context: BotContext,
  user: BotUser,
  chatId: number,
  status?: BotUser["status"],
): Promise<void> {
  const users = status
    ? await listUsersByStatus(status)
    : await listBotUsers();
  if (!users.length) {
    await sendMessage(context, chatId, "Bu listede kullanıcı yok.", user.id, adminPanelKeyboard());
    return;
  }

  const rows: InlineButton[][] = users.map((target) => [
    {
      text: `${statusLabel(target.status)} | ${displayName(target)} | ${target.telegramUserId}`,
      callback_data: `admin:user:${target.id}`,
    },
  ]);
  rows.push([{ text: "Yönetici paneline dön", callback_data: "admin:menu" }]);
  await sendMessage(
    context,
    chatId,
    status ? `${statusLabel(status)} kullanıcılar` : "Son kullanıcılar",
    user.id,
    { inline_keyboard: rows },
  );
}

async function sendAdminUserDetail(
  context: BotContext,
  actor: BotUser,
  target: BotUser,
  chatId: number,
): Promise<void> {
  await sendMessage(
    context,
    chatId,
    [
      "Kullanıcı detayı",
      "",
      `Ad: ${displayName(target)}`,
      `Telegram ID: ${target.telegramUserId}`,
      `Rol: ${roleLabel(target.role)}`,
      `Durum: ${statusLabel(target.status)}`,
      `Günlük çalıştırma limiti: ${target.dailyRunLimit}`,
      `Dosya limiti: ${Math.floor(target.maxFileBytes / 1024 / 1024)} MB`,
      `Katılım: ${formatDate(target.createdAt)}`,
      `Son görülme: ${formatDate(target.lastSeenAt)}`,
    ].join("\n"),
    actor.id,
    {
      inline_keyboard: [
        [
          { text: "Dosyaları", callback_data: `admin:files:${target.id}` },
          { text: "Mesaj geçmişi", callback_data: `admin:history:${target.id}` },
        ],
        [
          { text: "Aktif yap", callback_data: `admin:status:${target.id}:active` },
          { text: "Yasakla", callback_data: `admin:status:${target.id}:blocked` },
        ],
        [{ text: "Onay bekliyor", callback_data: `admin:status:${target.id}:pending` }],
        [
          { text: "Yönetici yap", callback_data: `admin:role:${target.id}:admin` },
          { text: "Kullanıcı yap", callback_data: `admin:role:${target.id}:user` },
        ],
        [{ text: "Kullanıcılara dön", callback_data: "admin:users" }],
      ],
    },
  );
}

async function sendAdminFiles(
  context: BotContext,
  actor: BotUser,
  target: BotUser,
  chatId: number,
): Promise<void> {
  const files = await listBotFiles(target.id);
  const body = files.length
    ? files
        .map(
          (file) =>
            `${file.filename} | ${Math.ceil(file.sizeBytes / 1024)} KB | ${file.runCount} çalıştırma | son: ${formatDate(file.lastRunAt)}`,
        )
        .join("\n")
    : "Dosya yok.";
  await sendMessage(
    context,
    chatId,
    `${displayName(target)} dosyaları:\n\n${body}`,
    actor.id,
    { inline_keyboard: [[{ text: "Kullanıcıya dön", callback_data: `admin:user:${target.id}` }]] },
  );
}

async function sendAdminHistory(
  context: BotContext,
  actor: BotUser,
  target: BotUser,
  chatId: number,
): Promise<void> {
  const messages = await listUserMessages(target.id, 30);
  const body = messages.length
    ? messages
        .reverse()
        .map(
          (message) =>
            `${formatDate(message.createdAt)} | ${message.direction === "incoming" ? "Gelen" : "Bot"} | ${message.text?.slice(0, 160) ?? `[${message.kind}]`}`,
        )
        .join("\n")
    : "Mesaj yok.";
  await sendMessage(
    context,
    chatId,
    `${displayName(target)} mesaj geçmişi:\n\n${body}`,
    actor.id,
    { inline_keyboard: [[{ text: "Kullanıcıya dön", callback_data: `admin:user:${target.id}` }]] },
  );
}

async function sendAdminTasks(
  context: BotContext,
  user: BotUser,
  chatId: number,
): Promise<void> {
  const tasks = await listBotTasks();
  const body = tasks.length
    ? tasks
        .map(
          (task) =>
            `${task.enabled ? "Açık" : "Kapalı"} | #${task.id} | ${task.title} | ${task.channelRef}`,
        )
        .join("\n")
    : "Henüz kanal görevi yok.";
  const rows: InlineButton[][] = tasks.map((task) => [
    {
      text: `${task.enabled ? "Kapat" : "Aç"} #${task.id}`,
      callback_data: `admin:task:toggle:${task.id}`,
    },
    { text: `Sil #${task.id}`, callback_data: `admin:task:delete:${task.id}` },
  ]);
  rows.push([{ text: "Yönetici paneline dön", callback_data: "admin:menu" }]);
  await sendMessage(
    context,
    chatId,
    `Kanal görevleri\n\n${body}\n\nYeni görev için:\n/task_add @kanal | Başlık | https://t.me/kanal`,
    user.id,
    { inline_keyboard: rows },
  );
}

async function sendAdminAudit(
  context: BotContext,
  user: BotUser,
  chatId: number,
): Promise<void> {
  const logs = await listAuditLogs(25);
  const body = logs.length
    ? logs
        .map(
          (log) =>
            `${formatDate(log.createdAt)} | ${log.action} | hedef: ${log.targetUserId ?? "—"}`,
        )
        .join("\n")
    : "Denetim kaydı yok.";
  await sendMessage(context, chatId, `Son yönetim kayıtları:\n\n${body}`, user.id, adminPanelKeyboard());
}

function adminCommandHelp(): string {
  return [
    "Yönetici komutları",
    "",
    "/access open — herkes kullanabilir",
    "/access approval — kullanıcı onayı gerekir",
    "/access closed — kullanıcı erişimini kapatır",
    "/approve TELEGRAM_ID — kullanıcıyı aktif yapar",
    "/block TELEGRAM_ID — kullanıcıyı yasaklar",
    "/unblock TELEGRAM_ID — yasağı kaldırır",
    "/admin_add TELEGRAM_ID — yönetici yapar",
    "/admin_remove TELEGRAM_ID — yönetici rolünü kaldırır",
    "/limit TELEGRAM_ID GÜNLÜK_LIMIT MB — kullanıcı limiti",
    "/task_add @kanal | Başlık | https://t.me/kanal",
    "/task_delete GÖREV_ID",
    "/task_toggle GÖREV_ID",
  ].join("\n");
}

async function findUserByTelegramId(
  telegramIdText: string | undefined,
): Promise<BotUser | undefined> {
  if (!telegramIdText || !/^\d+$/.test(telegramIdText)) {
    return undefined;
  }
  return getBotUserByTelegramId(Number(telegramIdText));
}

async function handleAdminCommand(
  context: BotContext,
  user: BotUser,
  message: TelegramMessage,
  command: string,
  args: string[],
  rawText: string,
): Promise<boolean> {
  if (user.role !== "admin") {
    return false;
  }

  if (command === "/admin" || command === "/admin_panel") {
    await sendAdminPanel(context, user, message.chat.id);
    return true;
  }

  if (command === "/access") {
    const mode = args[0];
    if (mode !== "open" && mode !== "approval" && mode !== "closed") {
      await sendMessage(context, message.chat.id, "Kullanım: /access open|approval|closed", user.id);
      return true;
    }
    await setSetting("access_mode", mode, user.id);
    await recordAudit({ actorUserId: user.id, action: "access_mode_changed", details: { mode } });
    await sendMessage(context, message.chat.id, `Erişim modu "${mode}" olarak ayarlandı.`, user.id, adminPanelKeyboard());
    return true;
  }

  if (command === "/approve" || command === "/block" || command === "/unblock") {
    const target = await findUserByTelegramId(args[0]);
    if (!target) {
      await sendMessage(context, message.chat.id, "Önce kullanıcının /start ile botu başlatmış olması gerekir.", user.id);
      return true;
    }
    const status = command === "/approve" || command === "/unblock" ? "active" : "blocked";
    await updateUserStatus(target.id, status);
    await recordAudit({
      actorUserId: user.id,
      action: `user_${status}`,
      targetUserId: target.id,
      details: { telegramUserId: target.telegramUserId },
    });
    await sendMessage(context, message.chat.id, `${target.telegramUserId} kullanıcısı ${statusLabel(status)} oldu.`, user.id);
    return true;
  }

  if (command === "/admin_add" || command === "/admin_remove") {
    const target = await findUserByTelegramId(args[0]);
    if (!target) {
      await sendMessage(context, message.chat.id, "Kullanıcı bulunamadı.", user.id);
      return true;
    }
    const role = command === "/admin_add" ? "admin" : "user";
    await updateUserRole(target.id, role);
    if (role === "admin") {
      await updateUserStatus(target.id, "active");
    }
    await recordAudit({ actorUserId: user.id, action: `role_${role}`, targetUserId: target.id });
    await sendMessage(context, message.chat.id, `${target.telegramUserId} rolü ${roleLabel(role)} oldu.`, user.id);
    return true;
  }

  if (command === "/limit") {
    const target = await findUserByTelegramId(args[0]);
    const dailyRunLimit = Number(args[1]);
    const maxFileBytes = Number(args[2]) * 1024 * 1024;
    if (!target || !Number.isInteger(dailyRunLimit) || dailyRunLimit < 0 || !Number.isInteger(maxFileBytes) || maxFileBytes < 1) {
      await sendMessage(context, message.chat.id, "Kullanım: /limit TELEGRAM_ID GÜNLÜK_LIMIT MB", user.id);
      return true;
    }
    await updateUserLimits(target.id, { dailyRunLimit, maxFileBytes });
    await recordAudit({ actorUserId: user.id, action: "user_limits_changed", targetUserId: target.id, details: { dailyRunLimit, maxFileBytes } });
    await sendMessage(context, message.chat.id, "Kullanıcı limitleri güncellendi.", user.id);
    return true;
  }

  if (command === "/task_add") {
    const parts = rawText
      .slice(rawText.indexOf(" ") + 1)
      .split("|")
      .map((part) => part.trim());
    if (parts.length < 3 || !parts[0] || !parts[1].startsWith("http")) {
      await sendMessage(context, message.chat.id, "Kullanım: /task_add @kanal | Başlık | https://t.me/kanal", user.id);
      return true;
    }
    const task = await createChannelTask({
      channelRef: parts[0],
      title: parts[1],
      joinUrl: parts[2],
      createdByUserId: user.id,
    });
    await recordAudit({ actorUserId: user.id, action: "task_created", details: { taskId: task.id, channelRef: task.channelRef } });
    await sendMessage(context, message.chat.id, `Kanal görevi #${task.id} oluşturuldu. Botu ${task.channelRef} kanalında yönetici yapmayı unutmayın.`, user.id, adminPanelKeyboard());
    return true;
  }

  if (command === "/task_delete" || command === "/task_toggle") {
    const taskId = Number(args[0]);
    if (!Number.isInteger(taskId)) {
      await sendMessage(context, message.chat.id, `Kullanım: ${command} GÖREV_ID`, user.id);
      return true;
    }
    if (command === "/task_delete") {
      await deleteTask(taskId);
    } else {
      const tasks = await listBotTasks();
      const task = tasks.find((item) => item.id === taskId);
      if (!task) {
        await sendMessage(context, message.chat.id, "Görev bulunamadı.", user.id);
        return true;
      }
      await setTaskEnabled(taskId, !task.enabled);
    }
    await recordAudit({ actorUserId: user.id, action: command === "/task_delete" ? "task_deleted" : "task_toggled", details: { taskId } });
    await sendMessage(context, message.chat.id, "Görev güncellendi.", user.id, adminPanelKeyboard());
    return true;
  }

  if (command === "/admin_help") {
    await sendMessage(context, message.chat.id, adminCommandHelp(), user.id, adminPanelKeyboard());
    return true;
  }

  return false;
}

async function handleCallback(
  context: BotContext,
  query: TelegramCallbackQuery,
): Promise<void> {
  await answerCallback(context, query.id).catch(() => undefined);
  const chatId = query.message?.chat.id;
  if (!chatId) {
    return;
  }
  const user = await upsertTelegramUser(
    {
      userId: query.from.id,
      chatId,
      username: query.from.username,
      firstName: query.from.first_name,
      lastName: query.from.last_name,
    },
    context.adminIds,
  );
  await recordMessage({
    userId: user.id,
    chatId,
    direction: "incoming",
    kind: "callback",
    text: query.data,
  });

  const data = query.data ?? "";
  if (data === "user:panel") {
    await sendUserPanel(context, user, chatId);
    return;
  }
  if (data === "user:files") {
    if (await requireAccess(context, user, chatId)) {
      await sendUserFiles(context, user, chatId);
    }
    return;
  }
  if (data === "user:history") {
    if (await requireAccess(context, user, chatId)) {
      await sendUserHistory(context, user, chatId);
    }
    return;
  }
  if (data === "user:profile") {
    if (await requireAccess(context, user, chatId)) {
      await sendUserProfile(context, user, chatId);
    }
    return;
  }
  if (data === "user:help") {
    await sendMessage(context, chatId, "Bir .py dosyası gönderin; dosya kaydedilir ve otomatik çalışır.\n\n/files — dosyalar\n/run dosya.py — tekrar çalıştır\n/delete dosya.py — sil\n/panel — kontrol paneli", user.id);
    return;
  }
  if (data === "user:check") {
    await sendUserPanel(context, user, chatId);
    return;
  }
  if (data.startsWith("user:file:view:")) {
    if (!(await requireAccess(context, user, chatId))) {
      return;
    }
    const fileId = Number(data.split(":")[3]);
    const file = await getBotFile(fileId, user.id);
    if (!file) {
      await sendMessage(context, chatId, "Dosya bulunamadı.", user.id);
      return;
    }
    await sendMessage(
      context,
      chatId,
      `${file.filename}\n\nBoyut: ${Math.ceil(file.sizeBytes / 1024)} KB\nÇalıştırma: ${file.runCount}\nSon çalıştırma: ${formatDate(file.lastRunAt)}`,
      user.id,
      {
        inline_keyboard: [
          [
            { text: "Çalıştır", callback_data: `user:file:run:${file.id}` },
            { text: "Sil", callback_data: `user:file:delete:${file.id}` },
          ],
          [{ text: "Dosyalara dön", callback_data: "user:files" }],
        ],
      },
    );
    return;
  }
  if (data.startsWith("user:file:run:")) {
    if (!(await requireAccess(context, user, chatId))) {
      return;
    }
    const file = await getBotFile(Number(data.split(":")[3]), user.id);
    if (file) {
      await runStoredFile(context, user, file, chatId);
    }
    return;
  }
  if (data.startsWith("user:file:delete:")) {
    if (!(await requireAccess(context, user, chatId))) {
      return;
    }
    const file = await getBotFile(Number(data.split(":")[3]), user.id);
    if (file) {
      await deleteBotFile(file.id);
      await rm(file.storagePath, { force: true });
      await recordAudit({ actorUserId: user.id, action: "file_deleted", targetUserId: user.id, details: { fileId: file.id, filename: file.filename } });
      await sendMessage(context, chatId, `${file.filename} silindi.`, user.id, userPanelKeyboard(user));
    }
    return;
  }

  if (user.role !== "admin") {
    await sendMessage(context, chatId, "Bu yönetim işlemi için yönetici yetkisi gerekir.", user.id);
    return;
  }
  if (data === "admin:menu") {
    await sendAdminPanel(context, user, chatId);
    return;
  }
  if (data === "admin:stats") {
    await sendAdminStats(context, user, chatId);
    return;
  }
  if (data === "admin:users") {
    await sendAdminUsers(context, user, chatId);
    return;
  }
  if (data === "admin:pending") {
    await sendAdminUsers(context, user, chatId, "pending");
    return;
  }
  if (data === "admin:access") {
    const mode = await getSetting("access_mode", "open");
    await sendMessage(context, chatId, `Mevcut erişim modu: ${mode}\n\nopen: herkes\napproval: yönetici onayı\nclosed: yalnızca yöneticiler`, user.id, {
      inline_keyboard: [
        [
          { text: "Herkese aç", callback_data: "admin:access:set:open" },
          { text: "Onay sistemi", callback_data: "admin:access:set:approval" },
        ],
        [{ text: "Kapat", callback_data: "admin:access:set:closed" }],
        [{ text: "Yönetici paneline dön", callback_data: "admin:menu" }],
      ],
    });
    return;
  }
  if (data.startsWith("admin:access:set:")) {
    const mode = data.split(":")[3];
    if (mode === "open" || mode === "approval" || mode === "closed") {
      await setSetting("access_mode", mode, user.id);
      await recordAudit({ actorUserId: user.id, action: "access_mode_changed", details: { mode } });
      await sendAdminStats(context, user, chatId);
    }
    return;
  }
  if (data === "admin:tasks") {
    await sendAdminTasks(context, user, chatId);
    return;
  }
  if (data === "admin:audit") {
    await sendAdminAudit(context, user, chatId);
    return;
  }
  if (data === "admin:commands") {
    await sendMessage(context, chatId, adminCommandHelp(), user.id, adminPanelKeyboard());
    return;
  }
  if (data.startsWith("admin:user:")) {
    const target = await getBotUserById(Number(data.split(":")[2]));
    if (target) {
      await sendAdminUserDetail(context, user, target, chatId);
    }
    return;
  }
  if (data.startsWith("admin:files:")) {
    const target = await getBotUserById(Number(data.split(":")[2]));
    if (target) {
      await sendAdminFiles(context, user, target, chatId);
    }
    return;
  }
  if (data.startsWith("admin:history:")) {
    const target = await getBotUserById(Number(data.split(":")[2]));
    if (target) {
      await sendAdminHistory(context, user, target, chatId);
    }
    return;
  }
  if (data.startsWith("admin:status:")) {
    const [, , userIdText, status] = data.split(":");
    const targetId = Number(userIdText);
    if (status === "active" || status === "blocked" || status === "pending") {
      await updateUserStatus(targetId, status);
      await recordAudit({ actorUserId: user.id, action: `user_${status}`, targetUserId: targetId });
      const target = await getBotUserById(targetId);
      if (target) {
        await sendAdminUserDetail(context, user, target, chatId);
      }
    }
    return;
  }
  if (data.startsWith("admin:role:")) {
    const [, , userIdText, role] = data.split(":");
    const targetId = Number(userIdText);
    if (role === "admin" || role === "user") {
      await updateUserRole(targetId, role);
      if (role === "admin") {
        await updateUserStatus(targetId, "active");
      }
      await recordAudit({ actorUserId: user.id, action: `role_${role}`, targetUserId: targetId });
      const target = await getBotUserById(targetId);
      if (target) {
        await sendAdminUserDetail(context, user, target, chatId);
      }
    }
    return;
  }
  if (data.startsWith("admin:task:toggle:")) {
    const taskId = Number(data.split(":")[3]);
    const tasks = await listBotTasks();
    const task = tasks.find((item) => item.id === taskId);
    if (task) {
      await setTaskEnabled(taskId, !task.enabled);
      await recordAudit({ actorUserId: user.id, action: "task_toggled", details: { taskId } });
    }
    await sendAdminTasks(context, user, chatId);
    return;
  }
  if (data.startsWith("admin:task:delete:")) {
    const taskId = Number(data.split(":")[3]);
    await deleteTask(taskId);
    await recordAudit({ actorUserId: user.id, action: "task_deleted", details: { taskId } });
    await sendAdminTasks(context, user, chatId);
  }
}

async function handleMessage(
  context: BotContext,
  message: TelegramMessage,
): Promise<void> {
  const sender = message.from;
  if (!sender) {
    return;
  }
  const user = await upsertTelegramUser(
    {
      userId: sender.id,
      chatId: message.chat.id,
      username: sender.username,
      firstName: sender.first_name,
      lastName: sender.last_name,
    },
    context.adminIds,
  );
  await recordMessage({
    userId: user.id,
    chatId: message.chat.id,
    telegramMessageId: message.message_id,
    direction: "incoming",
    kind: message.document ? "document" : "text",
    text: message.text ?? message.caption,
    metadata: message.document
      ? {
          filename: message.document.file_name,
          fileSize: message.document.file_size,
        }
      : undefined,
  });

  if (message.document) {
    await handleDocument(context, user, message);
    return;
  }
  const text = message.text?.trim();
  if (!text) {
    return;
  }
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();

  if (await handleAdminCommand(context, user, message, command, args, text)) {
    return;
  }
  if (command === "/start" || command === "/panel" || command === "/menu") {
    await sendUserPanel(context, user, message.chat.id);
    return;
  }
  if (command === "/help") {
    await sendMessage(context, message.chat.id, "Bir .py dosyası gönderin; dosya kaydedilir ve otomatik çalışır.\n\n/panel — kontrol paneli\n/files — dosyalar\n/run dosya.py — tekrar çalıştır\n/delete dosya.py — sil", user.id, userPanelKeyboard(user));
    return;
  }
  if (!(await requireAccess(context, user, message.chat.id))) {
    return;
  }
  if (command === "/files") {
    await sendUserFiles(context, user, message.chat.id);
    return;
  }
  if (command === "/history") {
    await sendUserHistory(context, user, message.chat.id);
    return;
  }
  if (command === "/profile") {
    await sendUserProfile(context, user, message.chat.id);
    return;
  }
  if (command === "/run") {
    const filename = normalizeFilename(args[0]);
    const files = filename ? await listBotFiles(user.id) : [];
    const file = files.find((item) => item.filename === filename);
    if (!file) {
      await sendMessage(context, message.chat.id, "Kullanım: /run dosya.py\n\nDosyaları görmek için /files yazın.", user.id);
      return;
    }
    await runStoredFile(context, user, file, message.chat.id);
    return;
  }
  if (command === "/delete") {
    const filename = normalizeFilename(args[0]);
    const files = filename ? await listBotFiles(user.id) : [];
    const file = files.find((item) => item.filename === filename);
    if (!file) {
      await sendMessage(context, message.chat.id, "Kullanım: /delete dosya.py", user.id);
      return;
    }
    await deleteBotFile(file.id);
    await rm(file.storagePath, { force: true });
    await recordAudit({ actorUserId: user.id, action: "file_deleted", targetUserId: user.id, details: { fileId: file.id, filename: file.filename } });
    await sendMessage(context, message.chat.id, `${filename} silindi.`, user.id, userPanelKeyboard(user));
    return;
  }
  await sendMessage(context, message.chat.id, "Komut tanınmadı. /help yazarak kullanımı görebilirsiniz.", user.id);
}

async function poll(context: BotContext): Promise<void> {
  let offset = Number(await getSetting("telegram_update_offset", "0"));
  await telegramRequest(context.token, "deleteWebhook", { drop_pending_updates: false });
  logger.info("Telegram gelişmiş bot polling başlatıldı");

  while (true) {
    try {
      const response = await telegramRequest<TelegramUpdate[]>(
        context.token,
        "getUpdates",
        {
          offset,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ["message", "callback_query"],
        },
        (POLL_TIMEOUT_SECONDS + 10) * 1_000,
      );
      for (const update of response.result) {
        offset = update.update_id + 1;
        if (update.message) {
          await handleMessage(context, update.message);
        } else if (update.callback_query) {
          await handleCallback(context, update.callback_query);
        }
        await setSetting("telegram_update_offset", String(offset));
      }
    } catch (error) {
      logger.error({ err: error }, "Telegram polling hatası; yeniden deneniyor");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

export function startTelegramBot(): void {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    logger.warn(
      "Telegram bot başlatılmadı: TELEGRAM_BOT_TOKEN gereklidir",
    );
    return;
  }
  void poll({ token, adminIds: ADMIN_TELEGRAM_IDS }).catch((error) => {
    logger.error({ err: error }, "Telegram bot başlatılamadı");
  });
}