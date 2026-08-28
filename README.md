# Moddable XS BLE OTA ESP32

A complete Moddable XS JavaScript application for the **ESP32-WROOM-32** that provides:

- **BLE GATT OTA service** — upload new JavaScript code wirelessly over BLE without USB.
- **Low-power operation** — light sleep during advertising gaps, deep sleep after extended idle.
- **NVS storage** — pending update persisted in flash (survives reboot).
- **Python companion client** — upload code from any PC or mobile device running Python.

---

## Repository Structure

```
moddable-ble-ota-esp32/
├── manifest.json          # Moddable project manifest
├── src/
│   ├── main.js            # Application entry point & BLE peripheral
│   ├── ota-manager.js     # OTA chunk reception & NVS storage
│   └── sleep-manager.js   # Light/deep sleep with wake-on-BLE logic
├── client/
│   └── ota_client.py      # Python BLE OTA client (uses Bleak)
└── README.md
```

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| [Moddable SDK](https://github.com/Moddable-OpenSource/moddable) | Latest | Follow platform setup for ESP32 |
| ESP-IDF | 5.x | Installed via Moddable SDK setup |
| Python | 3.9+ | For the companion client |
| [Bleak](https://pypi.org/project/bleak/) | 0.21+ | `pip install bleak` |

---

## Building & Flashing (first time)

```bash
# Set up Moddable environment variables (add to your shell profile)
export MODDABLE=/path/to/moddable
source $MODDABLE/build/makefiles/lin/setup.sh   # Linux
# source $MODDABLE/build/makefiles/mac/setup.sh # macOS

# Build and flash (USB required for initial flash only)
cd moddable-ble-ota-esp32
mcconfig -d -m -p esp32 -f mczip
```

After the initial flash the device advertises as **`Moddable-OTA`** and accepts
OTA updates over BLE — no further USB connections required.

---

## BLE Protocol

### Service & Characteristic UUIDs

| Name | UUID | Properties |
|------|------|-----------|
| **OTA Service** | `12345678-1234-1234-1234-123456789ABC` | – |
| **OTA Data** | `12345678-1234-1234-1234-123456789ABD` | Write, Write No Response |
| **OTA Commit** | `12345678-1234-1234-1234-123456789ABE` | Write |
| **OTA Status** | `12345678-1234-1234-1234-123456789ABF` | Notify, Read |

### Update Protocol

1. **Subscribe** to OTA Status characteristic notifications.
2. **Write** the new code in ≤512-byte chunks to **OTA Data** (Write No Response for speed).
3. After all chunks are sent, **write `0x01`** to **OTA Commit**.
4. The device responds with a status notification (`0x03` = SUCCESS) and reboots.

### Status Codes

| Byte | Meaning |
|------|---------|
| `0x00` | IDLE |
| `0x01` | RECEIVING chunks |
| `0x02` | COMMITTING to NVS |
| `0x03` | SUCCESS (device will reboot) |
| `0xFF` | ERROR |

---

## Python OTA Client

```bash
cd client
pip install bleak

# Discover nearby OTA devices
python ota_client.py --scan

# Upload a file to a specific device
python ota_client.py --address AA:BB:CC:DD:EE:FF --file path/to/new_app.js

# Verbose mode shows each chunk
python ota_client.py --address AA:BB:CC:DD:EE:FF --file new_app.js --verbose
```

---

## Power Consumption Tuning

| Mode | Typical Current | When Active |
|------|----------------|-------------|
| BLE advertising (connectable) | ~15–20 mA | Waiting for client |
| BLE connected (data transfer) | ~25–30 mA | OTA in progress |
| Light sleep (BLE controller on) | ~0.8–2 mA | Idle between adv. events |
| Deep sleep (wake on GPIO/timer) | ~10–20 µA | Extended idle |

### Tuning Parameters (`manifest.json` → `config`)

| Key | Default | Description |
|-----|---------|-------------|
| `sleep_timeout_ms` | `30000` | ms idle before entering light sleep |
| `max_ota_size` | `65536` | Max OTA payload bytes (NVS limit) |

Additional tuning inside `src/sleep-manager.js`:

```js
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;  // light sleep after 30 s idle
const DEEP_SLEEP_TIMEOUT_MS   = 300_000; // deep sleep after 5 min idle
```

Reduce advertising interval in `src/main.js` for lower average current:

```js
// Inside #startAdvertising():
this.startAdvertising({
  advertisingInterval: 500,  // ms; higher = lower power, slower discovery
  ...
});
```

---

## Security Considerations

> ⚠️  The current implementation provides **no authentication or encryption**.
> Anyone within BLE range can upload arbitrary code. For production deployments,
> implement the following mitigations:

1. **Signed payloads** — Compute an HMAC-SHA256 signature over the code bytes
   with a pre-shared key and verify it on-device before committing.
2. **Encrypted transport** — Enable BLE pairing/bonding (`LE Secure Connections`)
   so the link layer encrypts all characteristic writes.
3. **Allowlist** — Store a list of authorised central device addresses and reject
   connections from others.
4. **Time-limited OTA window** — Advertise the OTA service only for a configurable
   window after power-on, then switch to a non-connectable advertisement or stop
   advertising entirely.
5. **Rollback protection** — Keep the previous image in a second NVS key; restore
   it if the new code panics on first boot (detected via a boot-counter in NVS).

---

## Rollback Protection (recommended pattern)

```js
// In main.js — increment boot counter; if > 1 and no "healthy" flag, roll back
import Preference from "preference";
const boots = (Preference.get("ota", "bootCount") ?? 0) + 1;
Preference.set("ota", "bootCount", boots);
if (boots > 1 && !Preference.get("ota", "healthy")) {
  trace("main: unhealthy boot, rolling back\n");
  // Restore previous code from "ota"/"backup" key
}
// ... after app init succeeds:
Preference.set("ota", "healthy", 1);
Preference.set("ota", "bootCount", 0);
```

---

## License

MIT
