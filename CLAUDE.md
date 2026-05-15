# Darth-Pixit — Project Guide for Claude

## Code Quality Standard

Write code as if the person maintaining it is a violent psychopath who knows where you live. Make it that clear.

- Name things for what they actually do
- No clever tricks that need a comment to explain
- If a future reader would have to guess, rewrite it


## What This App Does

Darth-Pixit is a bare React Native mobile app that reads real-time OBD2 vehicle sensor data over Bluetooth Low Energy (BLE) and helps the driver save fuel. It shows:

- A horizontal throttle/engine-load gauge color-coded by eco zone (green / orange / red)
- A coaching message nudging the driver toward lower throttle ("Ease off — you're burning extra fuel")
- A live trip-average mileage display (km/L) accumulated from fuel consumption rate + speed
- Raw telemetry: RPM, speed (km/h), fuel rate (L/h)
- OBD connection status banner (scanning / connecting / ready / reconnecting / error)

It supports a Demo Mode (no hardware needed) that simulates a sine-wave throttle pattern for testing.

---

## Architecture Overview

```
BLE OBD2 Adapter
    ↓  AT commands over UART (base64, \r terminated)
OBDManager (singleton)          src/obd/OBDManager.ts
    - Scans/connects via react-native-ble-plx
    - Polls PIDs: RPM (010C), Speed (010D), MAF (0110),
                  Load (0104), IAT (010F), MAP (010B), Coolant (0105)
    - Computes fuel rate: MAF method (preferred) or MAP synthetic fallback
    - State machine: idle → scanning → connecting → ready → reconnecting → error
    - Exponential-backoff reconnect (1s … 30s cap, max 8 attempts)
    ↓  emit() callback on every data update
OBDStore (Zustand)              src/obd/OBDStore.ts
    - Thin reactive wrapper around OBDManager
    - Exposes useOBDStore() hook: all OBDData fields + start() + stop()
    ↓  React re-render on state change
ThrottleView (screen)           src/screens/ThrottleView.tsx
    - Only screen; reads store, animates gauge, computes trip avg
OBDStatusBanner (component)     src/obd/OBDStatusBanner.tsx
    - Top-of-screen connection status strip; hidden in idle state
App.tsx                         App.tsx
    - Root component; wraps ThrottleView in an ErrorBoundary
index.js                        index.js
    - Polyfills global.Buffer (required for BLE base64)
    - AppRegistry.registerComponent('DarthPixit', () => App)
```

---

## Key Files

| File | Role |
|------|------|
| `src/obd/OBDManager.ts` | BLE + OBD2 engine. All BLE logic lives here. |
| `src/obd/OBDStore.ts` | Zustand store — bridges OBDManager to React. |
| `src/obd/OBDStatusBanner.tsx` | Connection status UI strip. |
| `src/screens/ThrottleView.tsx` | Entire UI: gauge, coaching, trip avg, buttons. |
| `App.tsx` | Root with ErrorBoundary. |
| `index.js` | Entry point; Buffer polyfill + AppRegistry. |
| `ios/Podfile` | Clean bare-RN Podfile (no Expo references). |
| `eas.json` | EAS build: `production` profile (iOS Release IPA + Android APK). |
| `package.json` | Pure bare RN deps — no expo-* packages. |

---

## OBD2 Data & Fuel Calculation

### PID Polling Schedule
- **High priority (~250 ms):** RPM `010C`, Speed `010D`, MAF `0110`
- **Low priority (rotates ~2 s):** Engine Load `0104`, IAT `010F`, MAP `010B`, Coolant `0105`

### Fuel Rate Formula
1. **MAF method (preferred):** `fuelRateL/h = (MAF_g/s / stoichAFR) × 3600 / fuelDensity_g/L`
2. **MAP synthetic fallback:** synthesizes MAF from RPM, MAP, IAT using ideal-gas law + volumetric efficiency, then applies the same formula.

### Default Vehicle Config (`VehicleCfg`)
```ts
{ stoichAFR: 14.7, fuelDensityGPerL: 740, displacementL: 1.0, volEfficiency: 0.82 }
```
Passed to `start(vehicle)` from ThrottleView. Override per-vehicle in the future.

### Throttle/Load Zones
| Zone | Range | Color |
|------|-------|-------|
| Eco | 0–40% | `#22C55E` |
| Moderate | 40–70% | `#F59E0B` |
| Push | >70% | `#EF4444` |

Throttle = `engineLoadPct / 100` (preferred) or `rpm / 6000` (fallback).

---

## Trip Average Mileage

Accumulated in `ThrottleView` using `useRef` values (not state) to avoid stale closures inside `setInterval`:

- Every 500 ms, reads `fuelRateRef.current` and `speedRef.current`
- `tripDistRef += speed_km/h × dt_h`; `tripFuelRef += fuelRate_L/h × dt_h`
- `tripAvgKmL = tripDist / tripFuel` (shown once fuel > 0.005 L)
- Resets to null when `hasLiveData` becomes false (OBD disconnected + demo off)

In demo mode the values are synthesized: `fr = 0.8 + throttle × 9` L/h, `sp = 20 + throttle × 60` km/h.

---

## Critical Implementation Rules

### BleManager must be lazy
`new BleManager()` **must not** run at class property initialisation time. It must only be created on first `start()` call. Violating this causes a silent iOS crash before React mounts.

```ts
// CORRECT — in OBDManager.ts
private ble: BleManager | null = null;
private getBle(): BleManager {
  if (!this.ble) this.ble = new BleManager();
  return this.ble;
}
```

### Buffer polyfill must be first in index.js
```js
import { Buffer } from 'buffer';
global.Buffer = Buffer;
// then all other imports
```

### No Expo managed code
This is bare React Native. Never add `expo-*` packages, `registerRootComponent`, or `babel-preset-expo`. The Podfile has no `use_expo_modules!`.

### Zustand store is a singleton bridge
`OBDStore.ts` calls `OBDManager.getInstance()` at module load and wires the update handler. Do not instantiate OBDManager elsewhere.

---

## BLE Adapter Compatibility

OBDManager tries two GATT service profiles in order:
1. **FFF0/FFF1/FFF2** — cheap clone adapters (ELM327 generic)
2. **Nordic UART Service** — Vgate, OBDLink, authentic adapters

Device discovery filters for name substrings: `OBD`, `ELM`, `VGATE`, `ICAR`.

---

## State Machine

```
idle → scanning → connecting → ready ←→ reconnecting
                                ↓
                              error
```

- `reconnecting` uses exponential backoff; resets to `idle` on `stop()`
- `error` is terminal within a session; user must tap "Connect OBD Adapter" again

---

## Tech Stack

| Layer | Library |
|-------|---------|
| Framework | React Native 0.76.5 (bare) |
| Language | TypeScript (strict) |
| State | Zustand 5 |
| BLE | react-native-ble-plx 3 |
| JS Engine (iOS) | Hermes |
| Bundler | Metro (`@react-native/metro-config`) |
| Babel | `metro-react-native-babel-preset` |
| Builds | EAS (`production` profile) |

---

## Development Workflow

### Run locally (debug, Metro required)
```bash
npm start                      # start Metro bundler
npx react-native run-ios       # or run-android
```
On iOS, the debug build connects to Metro at the Mac's local IP (port 8081). A blank screen means Metro isn't running.

### Cloud builds via EAS
```bash
eas build --platform ios --profile production --clear-cache
eas build --platform android --profile production --clear-cache
```
iOS → downloadable IPA → upload to TestFlight via `eas submit` or Apple Transporter.
Android → downloadable APK → install directly on device (enable "Install unknown apps").

### iOS native setup (Mac only, one-time)
```bash
cd ios && pod install   # needs Ruby 3+ (brew install ruby) and CocoaPods
```
Xcode: set **Build Settings → User Script Sandboxing → No** (otherwise shell scripts are sandbox-denied).

### Git branching
- `main` is the integration branch — never push directly
- Feature branches: `<name>/feature-description` or `claude/feature-description`
- Open PRs into `main`; merge when CI passes

---

## UI & Styling Conventions

- Dark theme: background `#0D0D0D`, surfaces `#111` / `#1A1A1A`
- Accent palette: green `#22C55E`, amber `#F59E0B`, red `#EF4444`, blue `#3B82F6`
- Text: white `#FFFFFF` for values, `#555` for labels, `#444` for minor labels
- All dimensions relative to `Dimensions.get('window').width` with `PAD = 24`
- No third-party UI kit — all styles are inline `StyleSheet.create`

---

## Adding New OBD PIDs

1. Add the PID hex string to `HIGH_PIDS` or `LOW_PIDS` array in `OBDManager.ts`
2. Extend `OBDData` interface with the new field
3. Add a case in `applyPID()` to parse the hex response and store the value
4. Emit via `emit()` — the Zustand store will propagate it automatically
5. Read it in `ThrottleView.tsx` via `useOBDStore()`

---

## Firebase Phone Auth Setup (Android)

`signInWithPhoneNumber` on Android verifies the app via Play Integrity (or
reCAPTCHA fallback). Both fail with `auth/missing-client-identifier` unless the
signing certificate's SHA fingerprint is registered in Firebase Console for
project `mileagetracker-7cd8f`, package `com.darth.pixit`.

One-time setup per signing keystore (debug or release):

```bash
./scripts/print-firebase-shas.sh                          # debug.keystore
./scripts/print-firebase-shas.sh release.jks ALIAS PASS   # release keystore
```

Paste the printed SHA-1 and SHA-256 into Firebase Console → Project Settings →
Android app → "Add fingerprint", then download a fresh `google-services.json`
into `android/app/`. Rebuild the APK.

Local testing without Firebase Console access: add a test phone number under
Firebase Console → Authentication → Sign-in method → Phone → "Phone numbers for
testing". Debug builds set `appVerificationDisabledForTesting = true` in
`AuthContext.tsx`, so test numbers sign in without the Play Integrity check.

---

## Known Gotchas

- **Blank screen on device:** Metro not running, or BleManager instantiated eagerly (see lazy rule above).
- **Sandbox error in Xcode:** "User Script Sandboxing" must be `No` in Build Settings.
- **Pod install fails:** Needs Ruby 3+ from Homebrew, not system Ruby 2.6.
- **Trip avg never appears:** Only accumulates when both `fuelRate > 0.1 L/h` and `speed > 0.5 km/h` — idle or stationary driving doesn't count.
- **fillColor interpolation warning:** React Native Animated string interpolation requires `useNativeDriver: false` — already set.
- **`auth/missing-client-identifier` on Android Send OTP:** Signing-cert SHA not registered in Firebase Console — see "Firebase Phone Auth Setup (Android)" above.
