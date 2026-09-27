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
- `TELEGRAM_ADMIN_IDS`: Yetkili Telegram kullanıcı ID'leri; birden fazla değer virgülle ayrılır
- `DATA_DIR`: `/data`
- `DATABASE_URL`: Railway PostgreSQL servisinin bağlantı adresi

Start command:

```text
pnpm --filter @workspace/api-server run build && pnpm --filter @workspace/api-server run start
```

Railway'de bir **Volume** oluşturup `/data` yoluna bağlayın. Volume olmadan yüklenen dosyalar servis yeniden başlatıldığında veya yeniden dağıtıldığında kaybolabilir.

`nixpacks.toml`, Railway çalışma ortamına Python 3.12'yi ekler; botun `python3` çalıştırıcısı bu sayede hazır olur.

Kullanıcılar, dosyalar, mesaj geçmişi, görevler, erişim ayarları ve yönetim kayıtları PostgreSQL'de tutulur. Bu nedenle Railway projesine bir PostgreSQL servisi ekleyip bağlantı adresini `DATABASE_URL` olarak tanımlayın.

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