# Device probe (BRO-3033)

`maestro-device-probe` is a throwaway Paseo plugin. It does not live inside Maestro and nothing in Maestro imports it. It adds one screen and one sidebar row, **Device probe**. The screen measures what the host does around a plugin, showing each reading on screen and logging it with the `[probe]` prefix:

- the `params` it was opened with, its mount number and render count, and three buttons that call `openScreen` with a hold key, a JSON-ish key and a unicode plus 600-character value;
- where the host put it (`measureInWindow`), `layout.platform` and `layout.compact`;
- gradient swatches: `backgroundImage` and `experimental_backgroundImage`, linear and radial, and a `boxShadow` ring (grey means it did not render);
- four `PanResponder` cards (deck x, sheet y, deck x with 8 ms of JS work per move, a row inside a ScrollView). Each counts animation frames over 20 ms and 33 ms while dragged and says whether it was released or **terminated by the host**;
- RN `Keyboard` events, a host `TextInput`, an RN `TextInput` and a bottom composer that rides `endCoordinates.height`;
- an M1-style 49 pt tab bar inside RN `SafeAreaView`.

The results are in [`docs/design/next/device-checks.md`](../../docs/design/next/device-checks.md).

## Desktop (sandbox)

```sh
bun scripts/dogfood/up.ts --plugin "$PWD"
HOME=<sandbox>/home paseo plugin install "$PWD/scripts/device-probe" --host 127.0.0.1:<port>
# open the daemon URL, pick "Device probe" in the sidebar
bun scripts/dogfood/down.ts
```

## iOS simulator

This is what BRO-3033 did, and it costs about 15 GB of disk while it runs.

1. Clone the Paseo source at the host's tag:

   ```sh
   git clone --depth 1 --branch v0.11.1 https://github.com/getpaseo/paseo.git
   ```

2. **Before any install**, run `git -C paseo config core.hooksPath .git/hooks`, and run every install with `LEFTHOOK=0 HUSKY=0`. This Mac's `core.hooksPath` is global, and Paseo's `prepare` runs `lefthook install --force`.

3. Install and build the JS:

   ```sh
   npm ci
   npm run build:client
   npm run build:highlight
   npm run build:plugin
   npm run build --workspace=@getpaseo/expo-two-way-audio
   ```

4. In `packages/app`, generate the iOS project:

   ```sh
   APP_VARIANT=development npx expo prebuild -p ios --no-install
   cd ios && pod install
   ```

5. Xcode 26 needs its iOS platform (`xcodebuild -downloadPlatform iOS -architectureVariant arm64`, 8.4 GB). Build from the **`/private/tmp` real path**; Metro fails on the `/tmp` symlink:

   ```sh
   xcodebuild -workspace ios/PaseoDebug.xcworkspace -scheme PaseoDebug -configuration Release \
     -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
     CODE_SIGNING_ALLOWED=NO ARCHS=arm64 DEBUG_INFORMATION_FORMAT=dwarf COMPILER_INDEX_STORE_ENABLE=NO
   ```

   Watch free disk while it runs.

6. Create a simulator, then `simctl install` and `simctl launch sh.paseo.debug`. Choose **Direct connection**, enter `127.0.0.1` and the sandbox port, and open **Device probe** from the menu.

7. Drive it with [AXe](https://github.com/cameroncooke/AXe): `axe swipe`, `axe tap` and `axe describe-ui`. It injects touches into the simulator without moving the Mac's cursor.

8. Push Maestro's real payloads with `xcrun simctl push <udid> sh.paseo.debug payload.apns`.

9. Delete the simulator, the runtime and the build afterwards.

## The owner's iPhone

To read frame drops or the software keyboard on a real phone, install the probe on the real daemon:

```sh
paseo plugin install <repo>/scripts/device-probe
```

Then open **Device probe** on the phone, and remove it afterwards:

```sh
paseo plugin uninstall maestro-device-probe
```

Agents never do this step: it changes the owner's daemon.
