# Telegram Python Bot on Railway

Bu servis, Telegram üzerinden yetkili kullanıcıların Python dosyalarını yönetmesini sağlar.

## Telegram komutları

- `.py` dosyası gönderildiğinde dosya kaydedilir ve otomatik çalıştırılır.
- `/files` kayıtlı dosyaları listeler.
- `/run dosya.py` dosyayı tekrar çalıştırır.
- `/delete dosya.py` dosyayı siler.
- `/help` kullanım bilgisini gösterir.

## Railway ayarları

Railway projesinde bu repository için aşağıdaki değişkenleri tanımlayın:

- `TELEGRAM_BOT_TOKEN`: BotFather tarafından verilen bot token'ı

Start command:

```text
pnpm --filter @workspace/api-server run build && pnpm --filter @workspace/api-server run start
```

Railway'de bir **Volume** oluşturup `/data` yoluna bağlayın. SQLite veritabanı ve yüklenen dosyalar bu Volume altında tutulur. Volume olmadan kullanıcılar, görevler, geçmiş ve dosyalar servis yeniden başlatıldığında veya yeniden dağıtıldığında kaybolabilir.

`nixpacks.toml`, Railway çalışma ortamına Python 3.12'yi ekler; botun `python3` çalıştırıcısı bu sayede hazır olur.

Bot, Node.js'in yerleşik SQLite desteğini kullanır. Admin ID kod içine sabitlenmiştir; Railway'de `TELEGRAM_ADMIN_IDS`, `DATABASE_URL` veya `DATA_DIR` eklemeniz gerekmez.

Healthcheck path:

```text
/api/healthz
```

## Çalıştırma sınırları

- Yalnızca `.py` dosyaları kabul edilir.
- Dosya boyutu en fazla 5 MB'dir.
- Bir Python çalıştırması en fazla 20 saniye sürer.
- Telegram'a gönderilen çıktı en fazla 12.000 karakterle sınırlandırılır.

Bu bot güvenilen yöneticilerin kendi dosyalarını çalıştırması için tasarlanmıştır. Python kodu sunucuda çalıştığı için tanımadığınız kullanıcılara yetki vermeyin ve yönetici listesine yalnızca güvendiğiniz Telegram ID'lerini ekleyin.