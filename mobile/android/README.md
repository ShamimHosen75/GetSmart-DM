# SIDM for Android

The SIDM download manager for Android phones, installed from the SIDM website as an APK (it is not in the Play Store, because it downloads videos from social sites).

- Share a link to SIDM from Instagram, TikTok, Facebook, YouTube, X or any app, paste a link, or browse inside SIDM.
- Videos: [yt-dlp](https://github.com/yt-dlp/yt-dlp) and ffmpeg run on the phone (packed by [youtubedl-android](https://github.com/JunkFood02/youtubedl-android)). The original quality is offered first. yt-dlp updates itself once a day, so sites keep working when they change.
- Files: SIDM's own engine downloads with several connections at once, pauses and resumes, and respects the speed limit.
- Finished files go to `Downloads/SIDM` (visible in the Files app and the Gallery).
- English and Bangla, light and dark theme, switchable in Settings.
- DRM services (Netflix, Prime Video, Disney+, Spotify and others) are refused, as everywhere in SIDM.

## Layout

| Folder | What |
|---|---|
| `core/` | Plain Kotlin, no Android: link rules (`Links`, `FileNames`), the multi-connection engine (`HttpEngine`, `Segment`, `SpeedLimiter`), yt-dlp format parsing and arguments (`VideoFormats`, `YtdlpArgs`), cookie files. Tested on any JVM. |
| `app/` | The Android app (Kotlin, Jetpack Compose). `Engine` runs the queue, `VideoTools` wraps yt-dlp, `Saver` writes to Downloads/SIDM, `DownloadService` keeps downloads going in the background, `Updates` handles yt-dlp and app updates, `Strings` holds every English and Bangla string, `ui/` has the screens. |

## Build

Needs JDK 17 and the Android SDK (platform 35). GitHub Actions (`.github/workflows/android.yml`) builds and tests every push that touches `mobile/android/`, and uploads the APKs as the `sidm-android-apks` artifact.

```sh
cd mobile/android
./gradlew :core:test :app:testDebugUnitTest      # tests
./gradlew :app:assembleDebug                      # debug APKs, signed with a debug key
./gradlew :app:assembleRelease                    # release APKs (see signing)
SIDM_CORE_ONLY=1 gradle :core:test                # core tests without the Android SDK
```

One APK is built per processor type: `app-arm64-v8a-*.apk` (nearly every phone since 2017; the website's main download), `app-armeabi-v7a-*.apk` (older 32-bit phones) and `app-x86_64-*.apk` (emulators only). Each is about 50 MB, mostly Python and ffmpeg.

The app checks `https://sidm.online/version.json` for new versions and downloads updates from `https://sidm.online/downloads/sidm-v<version>-android.apk`. To build for another address, set `SIDM_SITE_URL` (environment variable, or the `SIDM_SITE_URL` repository variable in GitHub Actions).

## Signing

Android only installs an update that is signed with the same key as the installed app, so every release must be signed with the one SIDM release key. **If that key is lost, users must uninstall SIDM to install a newer version.** Keep a backup.

The release build is signed when it finds the key, from either:
- environment variables `SIDM_KEYSTORE` (path), `SIDM_KEYSTORE_PASSWORD`, `SIDM_KEY_ALIAS` (default `sidm`), `SIDM_KEY_PASSWORD`; in GitHub Actions, add the repository secrets `SIDM_KEYSTORE_BASE64` (the keystore file, base64-encoded) and `SIDM_KEYSTORE_PASSWORD`;
- or `mobile/android/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`), which is gitignored.

Without the key, `assembleRelease` makes unsigned APKs (`app-*-release-unsigned.apk`); sign them with `apksigner sign --ks sidm-release.jks app-arm64-v8a-release-unsigned.apk` (after `zipalign -p 4`) before publishing. Never commit the keystore or its passwords.

## Release

The Android app shares the SIDM version: `python scripts/bump.py` sets `sidmVersionName` and raises `sidmVersionCode` in `app/build.gradle.kts`. Then build the signed release APKs and run

```sh
python scripts/release.py --apk-dir mobile/android/app/build/outputs/apk/release
```

which copies them to `site/downloads/sidm-v<version>-android.apk` and `-android-32bit.apk`, refuses unsigned APKs, and fills in the size and SHA-256 on the website (`data-release="android-*"` markers).

Add `--android-only` to leave the other downloads as they are. GitHub Actions can do all of this: Actions > android > Run workflow, pick the release branch, tick "publish". It builds the signed APKs with the secrets above, runs `release.py --android-only` and commits the APKs and website changes to that branch.

Each APK is about 60 MB (Python, yt-dlp and ffmpeg are inside), so check that the website host accepts files that large (Cloudflare Pages, for one, stops at 25 MB per file).

## License note

youtubedl-android is GPL-3.0 and is part of the APK, so the APK as a whole is distributed under GPL-3.0 terms: SIDM's source code is public in this repository, and the About screen links to it.

## Manual testing

See `QA.md`.
