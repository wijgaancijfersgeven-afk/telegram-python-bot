# Telegram Python File Bot

Telegram üzerinden yetkili kullanıcıların Python dosyalarını yükleyip yönetmesini ve kontrollü şekilde çalıştırmasını sağlayan bot servisi.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Required env: `TELEGRAM_BOT_TOKEN` — BotFather token

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: SQLite (`node:sqlite`) stored in the data directory
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/telegramBot.ts` — Telegram polling, kullanıcı paneli, admin paneli, görevler, geçmiş ve Python çalıştırma akışı
- `artifacts/api-server/src/telegramStore.ts` — Telegram botu için kullanıcı, dosya, mesaj, görev ve audit veritabanı erişimi
- `artifacts/api-server/src/index.ts` — HTTP sunucusunu ve botu başlatır
- `artifacts/api-server/src/telegramStore.ts` — SQLite şeması ve Telegram botu veri erişimi
- `RAILWAY.md` — Railway kurulum ve kalıcı Volume ayarları
- `railway.json` — Railway build, start ve healthcheck ayarları

## Architecture decisions

- Telegram webhook yerine long polling kullanılır; Railway'de public webhook URL'si zorunlu değildir.
- Dosyalar ve yönetim verileri SQLite dosyası ile kullanıcıya özel Volume klasörlerinde tutulur.
- Ana yönetici ID'si bot kodunda sabitlenmiştir; çalışma zamanında yalnızca bot tokenı gerekir.
- Python süreçleri 20 saniye ve 12.000 karakter çıktı sınırıyla çalıştırılır.
- Kullanıcı erişimi `open`, `approval` veya `closed` modlarından biriyle yönetilir.

## Product

- Yetkili kullanıcı `.py` dosyası göndererek dosyayı saklar ve otomatik çalıştırır.
- Dosya listesi, tekrar çalıştırma ve silme komutları vardır.
- Telegram içi kullanıcı ve yönetici panelleri vardır.
- Yönetici kullanıcı onayı, ban, rol, limit, kanal görevi ve audit kayıtlarını yönetebilir.
- Railway Volume ile dosyalar yeniden başlatmalar arasında korunur.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
