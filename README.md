# JOY Web/PWA v0.1

This is the web/PWA companion to the native JOY Android v1.1 pilot.

## What works in this PWA
- Responsive JOY interface for iPhone, iPad, Android, and desktop browsers
- Installable PWA / iPhone Add to Home Screen
- Shared Profile Schema v3
- Verified GGL-compatible Web Bluetooth transport (`FFFE` / `FE02`) when `navigator.bluetooth` is available
- master intensity, 3-zone controls, STOP ALL, and ten test patterns
- standard BLE battery read when exposed
- encrypted JOY relay sessions interoperable with the Android relay format
- private text
- encrypted remote MASTER / PATTERN / STOP commands
- Talk, push-to-talk, and video using WebRTC + JOY relay signaling
- Music Sync
- Live Sound Sync
- responsive phone/tablet/desktop UI
- offline application-shell caching

## iPhone Bluetooth
Ordinary Safari currently does not expose Web Bluetooth. JOY detects that condition instead
of pretending Bluetooth is available. For the no-Apple-membership pilot, open the JOY PWA
through a Web Bluetooth-capable iPhone bridge/browser. Later, the JOY native bridge can expose
CoreBluetooth to this same PWA.

## GitHub Pages
The included GitHub Actions workflow syntax-checks the client, runs the relay integration
self-test, and deploys the `site/` folder to GitHub Pages.

After the first push, in the GitHub repository open:
Settings → Pages → Build and deployment → Source → GitHub Actions
(if GitHub has not already selected it automatically).

## Relay
The PWA needs an HTTPS JOY relay for partner sessions. `relay-server/` contains the same
session/event design used by Android plus CORS support for web clients.

The relay is not deployed by GitHub Pages because Pages is static hosting. We will deploy the
relay separately and then paste its HTTPS address into JOY.

## Security notes
- Unknown Bluetooth hardware is not given arbitrary write access.
- The PWA driver only enables control after the expected verified profile transport is present.
- Partner payloads are encrypted client-side with AES-GCM before the relay receives them.
- Camera/microphone are requested only when the user starts media features.
