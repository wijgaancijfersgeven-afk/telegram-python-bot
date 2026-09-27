import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { logger } from "./lib/logger";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 12_000;
const SCRIPT_TIMEOUT_MS = 20_000;
const POLL_TIMEOUT_SECONDS = 25;
const DATA_DIR = process.env["DATA_DIR"] ?? join(process.cwd(), "data");

type TelegramUser = {
  id: number;
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
  document?: TelegramDocument;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type TelegramFile = {
  file_path?: string;
};

type TelegramResponse<T> = {
  ok: boolean;
  result: T;
  description?: string;
};

type RunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
};

function getAdminIds(): Set<string> {
  return new Set(
    (process.env["TELEGRAM_ADMIN_IDS"] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

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

function chatDirectory(chatId: number): string {
  return join(DATA_DIR, String(chatId));
}

function filePathFor(chatId: number, filename: string): string {
  return join(chatDirectory(chatId), filename);
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
  token: string,
  chatId: number,
  text: string,
): Promise<void> {
  const chunks = text.match(/[\s\S]{1,3900}/g) ?? [text];
  for (const chunk of chunks) {
    await telegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text: chunk,
    });
  }
}

async function listPythonFiles(chatId: number): Promise<string[]> {
  const directory = chatDirectory(chatId);
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".py",
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function downloadTelegramFile(
  token: string,
  fileId: string,
  destination: string,
): Promise<void> {
  const fileResponse = await telegramRequest<TelegramFile>(token, "getFile", {
    file_id: fileId,
  });
  if (!fileResponse.result.file_path) {
    throw new Error("Telegram dosya yolu döndürmedi.");
  }

  const response = await fetch(
    `https://api.telegram.org/file/bot${token}/${fileResponse.result.file_path}`,
    { signal: AbortSignal.timeout(35_000) },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Telegram dosyası indirilemedi: ${response.statusText}`);
  }

  await pipeline(response.body, createWriteStream(destination));
}

async function runPythonFile(
  chatId: number,
  filename: string,
): Promise<RunResult> {
  const scriptPath = filePathFor(chatId, filename);
  const workingDirectory = chatDirectory(chatId);
  const chunks: Buffer[] = [];
  let outputBytes = 0;
  let timedOut = false;

  return new Promise((resolve) => {
    const child = spawn("python3", ["-u", scriptPath], {
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

      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      const kept = chunk.subarray(0, remaining);
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

function helpText(): string {
  return [
    "Dosya yöneticisi hazır.",
    "",
    "• Python dosyası gönder: kaydedilir ve otomatik çalıştırılır",
    "• /files — kayıtlı dosyaları göster",
    "• /run dosya.py — dosyayı tekrar çalıştır",
    "• /delete dosya.py — dosyayı sil",
    "• /help — bu yardımı göster",
    "",
    "Dosya sınırı: 5 MB | Çalışma süresi: 20 saniye",
  ].join("\n");
}

async function handleMessage(
  token: string,
  message: TelegramMessage,
  adminIds: Set<string>,
): Promise<void> {
  const senderId = message.from?.id;
  if (!senderId || !adminIds.has(String(senderId))) {
    return;
  }

  const chatId = message.chat.id;
  const text = message.text?.trim();

  if (message.document) {
    const filename = normalizeFilename(message.document.file_name);
    if (!filename) {
      await sendMessage(
        token,
        chatId,
        "Sadece .py uzantılı dosyalar kabul edilir. Dosya adını kontrol edin.",
      );
      return;
    }

    if (
      message.document.file_size !== undefined &&
      message.document.file_size > MAX_FILE_BYTES
    ) {
      await sendMessage(token, chatId, "Dosya çok büyük. En fazla 5 MB yükleyebilirsiniz.");
      return;
    }

    const directory = chatDirectory(chatId);
    await mkdir(directory, { recursive: true });
    const destination = filePathFor(chatId, filename);

    try {
      await downloadTelegramFile(token, message.document.file_id, destination);
      const downloaded = await stat(destination);
      if (downloaded.size > MAX_FILE_BYTES) {
        await rm(destination, { force: true });
        await sendMessage(token, chatId, "Dosya çok büyük. En fazla 5 MB yükleyebilirsiniz.");
        return;
      }

      await sendMessage(token, chatId, `📥 ${filename} kaydedildi. Çalıştırılıyor...`);
      const result = await runPythonFile(chatId, filename);
      await sendMessage(token, chatId, formatRunResult(filename, result));
    } catch (error) {
      await rm(destination, { force: true }).catch(() => undefined);
      const detail = error instanceof Error ? error.message : "Bilinmeyen hata";
      logger.error({ err: error, chatId, filename }, "Telegram dosyası işlenemedi");
      await sendMessage(token, chatId, `Dosya işlenemedi: ${detail}`);
    }
    return;
  }

  if (!text) {
    return;
  }

  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();

  try {
    if (command === "/start" || command === "/help") {
      await sendMessage(token, chatId, helpText());
      return;
    }

    if (command === "/files") {
      const files = await listPythonFiles(chatId);
      await sendMessage(
        token,
        chatId,
        files.length ? `Kayıtlı dosyalar:\n\n${files.join("\n")}` : "Henüz kayıtlı Python dosyası yok.",
      );
      return;
    }

    if (command === "/run") {
      const filename = normalizeFilename(args[0]);
      if (!filename) {
        await sendMessage(token, chatId, "Kullanım: /run dosya.py");
        return;
      }

      try {
        await stat(filePathFor(chatId, filename));
      } catch {
        await sendMessage(token, chatId, `${filename} bulunamadı. /files ile dosyaları görebilirsiniz.`);
        return;
      }

      await sendMessage(token, chatId, `▶️ ${filename} çalıştırılıyor...`);
      const result = await runPythonFile(chatId, filename);
      await sendMessage(token, chatId, formatRunResult(filename, result));
      return;
    }

    if (command === "/delete") {
      const filename = normalizeFilename(args[0]);
      if (!filename) {
        await sendMessage(token, chatId, "Kullanım: /delete dosya.py");
        return;
      }

      await rm(filePathFor(chatId, filename), { force: true });
      await sendMessage(token, chatId, `🗑️ ${filename} silindi.`);
      return;
    }

    await sendMessage(token, chatId, "Komut tanınmadı. /help yazarak kullanımı görebilirsiniz.");
  } catch (error) {
    logger.error({ err: error, chatId }, "Telegram mesajı işlenemedi");
    await sendMessage(token, chatId, "İşlem sırasında bir hata oluştu.");
  }
}

async function poll(token: string, adminIds: Set<string>): Promise<void> {
  let offset = 0;

  await telegramRequest(token, "deleteWebhook", { drop_pending_updates: false });
  logger.info("Telegram bot polling başlatıldı");

  while (true) {
    try {
      const response = await telegramRequest<TelegramUpdate[]>(
        token,
        "getUpdates",
        {
          offset,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ["message"],
        },
        (POLL_TIMEOUT_SECONDS + 10) * 1_000,
      );

      for (const update of response.result) {
        offset = update.update_id + 1;
        if (update.message) {
          await handleMessage(token, update.message, adminIds);
        }
      }
    } catch (error) {
      logger.error({ err: error }, "Telegram polling hatası; yeniden deneniyor");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

export function startTelegramBot(): void {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const adminIds = getAdminIds();

  if (!token || adminIds.size === 0) {
    logger.warn(
      "Telegram bot başlatılmadı: TELEGRAM_BOT_TOKEN ve TELEGRAM_ADMIN_IDS gereklidir",
    );
    return;
  }

  void poll(token, adminIds).catch((error) => {
    logger.error({ err: error }, "Telegram bot başlatılamadı");
  });
}