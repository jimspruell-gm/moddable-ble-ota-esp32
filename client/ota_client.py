#!/usr/bin/env python3
"""
ota_client.py – BLE OTA companion script for Moddable XS ESP32 firmware.

Sends a JavaScript code file to the ESP32 running the BLE OTA service,
chunk-by-chunk, then triggers a commit to reboot the device with the
new code stored in NVS.

Requirements:
    pip install bleak

Usage:
    python ota_client.py --address AA:BB:CC:DD:EE:FF --file new_app.js
    python ota_client.py --scan          # discover nearby OTA devices
"""

import asyncio
import argparse
import sys
import time
from pathlib import Path
from bleak import BleakClient, BleakScanner

# ── BLE UUIDs (must match manifest.json config) ──────────────────────────────
OTA_SERVICE_UUID     = "12345678-1234-1234-1234-123456789abc"
OTA_DATA_CHAR_UUID   = "12345678-1234-1234-1234-123456789abd"
OTA_COMMIT_CHAR_UUID = "12345678-1234-1234-1234-123456789abe"
OTA_STATUS_CHAR_UUID = "12345678-1234-1234-1234-123456789abf"

DEVICE_NAME          = "Moddable-OTA"
CHUNK_SIZE           = 512   # bytes per BLE write; must match device maxBytes
INTER_CHUNK_DELAY    = 0.05  # seconds between chunk writes

# ── Status codes returned by the device ─────────────────────────────────────
STATUS = {
    0x00: "IDLE",
    0x01: "RECEIVING",
    0x02: "COMMITTING",
    0x03: "SUCCESS",
    0xFF: "ERROR",
}


# ─── Device Discovery ────────────────────────────────────────────────────────

async def scan_for_devices(timeout: float = 10.0):
    """Scan for BLE devices advertising the OTA service."""
    print(f"Scanning for BLE devices for {timeout:.0f} s…")
    devices = await BleakScanner.discover(timeout=timeout)
    ota_devices = [
        d for d in devices
        if (d.name and DEVICE_NAME.lower() in d.name.lower())
        or OTA_SERVICE_UUID in (d.metadata.get("uuids") or [])
    ]
    if not ota_devices:
        print("No OTA devices found.")
        return []
    print(f"Found {len(ota_devices)} OTA device(s):")
    for d in ota_devices:
        print(f"  {d.address}  {d.name or '(unknown)'}")
    return ota_devices


# ─── OTA Upload ──────────────────────────────────────────────────────────────

async def upload_ota(address: str, payload: bytes, *, verbose: bool = False):
    """Connect to device and upload payload bytes via BLE OTA protocol."""

    status_received: list[int] = []

    def on_status_notify(_handle, data: bytearray):
        code = data[0] if data else 0xFF
        label = STATUS.get(code, f"UNKNOWN(0x{code:02X})")
        print(f"[status] {label}")
        status_received.append(code)

    print(f"Connecting to {address}…")
    async with BleakClient(address, timeout=15.0) as client:
        if not client.is_connected:
            print("ERROR: Failed to connect.", file=sys.stderr)
            return False

        print("Connected. Subscribing to status notifications…")
        await client.start_notify(OTA_STATUS_CHAR_UUID, on_status_notify)

        total = len(payload)
        chunks = [payload[i:i + CHUNK_SIZE] for i in range(0, total, CHUNK_SIZE)]
        print(f"Uploading {total} bytes in {len(chunks)} chunk(s) of up to {CHUNK_SIZE} bytes…")

        start = time.monotonic()
        for idx, chunk in enumerate(chunks):
            await client.write_gatt_char(OTA_DATA_CHAR_UUID, chunk, response=False)
            if verbose:
                print(f"  chunk {idx + 1}/{len(chunks)}: {len(chunk)} bytes")
            await asyncio.sleep(INTER_CHUNK_DELAY)

        elapsed = time.monotonic() - start
        speed = total / elapsed if elapsed > 0 else 0
        print(f"Upload complete in {elapsed:.1f} s ({speed:.0f} bytes/s).")

        # Commit – device will reboot after this
        print("Sending commit signal…")
        await client.write_gatt_char(OTA_COMMIT_CHAR_UUID, bytes([0x01]), response=True)

        # Wait briefly for status notification
        await asyncio.sleep(1.0)
        await client.stop_notify(OTA_STATUS_CHAR_UUID)

    last_status = status_received[-1] if status_received else None
    if last_status == 0x03:
        print("OTA update committed successfully. Device is rebooting.")
        return True
    elif last_status == 0xFF:
        print("ERROR: Device reported an error during OTA.", file=sys.stderr)
        return False
    else:
        print(f"OTA committed (last status: {STATUS.get(last_status, 'N/A')}). "
              "Device should reboot shortly.")
        return True


# ─── CLI ─────────────────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(
        description="BLE OTA client for Moddable XS ESP32 firmware."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--scan", action="store_true",
        help="Scan for nearby OTA devices and print their addresses."
    )
    group.add_argument(
        "--address", metavar="ADDR",
        help="BLE address of the target device (e.g. AA:BB:CC:DD:EE:FF)."
    )
    parser.add_argument(
        "--file", metavar="PATH",
        help="Path to the file to upload (required with --address)."
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="Print each chunk as it is sent."
    )
    parser.add_argument(
        "--scan-timeout", type=float, default=10.0, metavar="SECS",
        help="Scan duration in seconds (default: 10)."
    )
    return parser.parse_args()


async def async_main():
    args = parse_args()

    if args.scan:
        await scan_for_devices(timeout=args.scan_timeout)
        return

    if not args.file:
        print("ERROR: --file is required when using --address.", file=sys.stderr)
        sys.exit(1)

    file_path = Path(args.file)
    if not file_path.exists():
        print(f"ERROR: file not found: {file_path}", file=sys.stderr)
        sys.exit(1)

    payload = file_path.read_bytes()
    if len(payload) == 0:
        print("ERROR: file is empty.", file=sys.stderr)
        sys.exit(1)

    ok = await upload_ota(args.address, payload, verbose=args.verbose)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    asyncio.run(async_main())
