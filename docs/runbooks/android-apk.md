# APK для Android: сборка, ключ, проверка

Приложение — Trusted Web Activity (`android/`, пакет `ru.scanflow.app`). Оно открывает
`https://scanflow.ru/m/` в Chrome без адресной строки. Сайт обновляется сам, и пересобирать APK
нужно только при правках `android/`: иконка, название, цвета, версия библиотеки.
Спек — `docs/superpowers/specs/2026-11-06-mobile-app-design.md`.

## Как собирается

`.github/workflows/android.yml`:
- **PR с правками `android/`** — debug-сборка, APK в артефактах запуска (14 дней). Её можно
  поставить для проверки. Ключ у неё временный, поэтому поверх боевого APK она не встанет.
- **`main` с правками `android/` или ручной запуск** (Actions → Android APK → Run workflow) —
  подписанный APK. Он уходит на сервер в `~/www/scanflow.ru/app/data/downloads/`: туда же
  кладётся `android-cert-sha256.txt`. Сайт отдаёт их по адресам `/downloads/scanflow.apk`
  и `/.well-known/assetlinks.json`, перезапуск не нужен.
- Номер версии (`versionCode`) — номер запуска workflow. Он только растёт, поэтому обновление
  ставится поверх старой версии. Не переименовывайте `android.yml`: номер начнётся с 1, и
  телефоны откажутся ставить «старую» версию.

## Ключ подписи

- Хранится **на сервере**: `~/scanflow-android/release.p12` и пароль `~/scanflow-android/password`.
  Это вне каталога приложения, поэтому rsync выкладки ключ не трогает.
- Первая сборка на `main` создаёт ключ сама (RSA 3072, 10000 дней). Следующие берут его оттуда же.
- **Сделайте резервную копию** (после явного «да» владельца, скилл `prod`, или по SSH):
  `scp magday@magday.ru:'~/scanflow-android/*' ./scanflow-android-backup/`.
  Храните её вне репозитория: он публичный.
- Если ключ потерян, следующая сборка создаст новый, и сайт подтвердит уже его. Но APK с новым
  ключом не встанет поверх старого: на телефонах приложение придётся удалить и поставить заново.

## Проверка

1. `https://scanflow.ru/.well-known/assetlinks.json` — пакет `ru.scanflow.app` и тот же
   отпечаток SHA-256, что в итоге запуска workflow (Summary).
2. Проверка Google: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://scanflow.ru&relation=delegate_permission/common.handle_all_urls`.
3. На телефоне: скачать `https://scanflow.ru/downloads/scanflow.apk`, разрешить установку из
   браузера и открыть. Адресной строки быть не должно. Если она есть, отпечаток на сайте не
   совпал с ключом APK или Chrome закешировал старую проверку (поможет переустановка).

## Google Play или RuStore

При публикации в Google Play с «Подписанием приложений в Google Play» магазин подписывает APK
своим ключом. Его SHA-256 (Play Console → Целостность приложения) добавьте в серверный `.env`:
`ANDROID_CERT_SHA256=AA:BB:…` (несколько — через запятую), затем `pm2 restart scanflow`.
Сайт подтвердит оба ключа.

## Собрать у себя

Нужны JDK 17+, Gradle 8.14 и Android SDK (`platforms;android-36`, `build-tools;36.0.0`):

```bash
export ANDROID_HOME=~/android-sdk
gradle -p android assembleDebug     # android/app/build/outputs/apk/debug/app-debug.apk
```
