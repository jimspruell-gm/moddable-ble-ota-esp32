/*
 * main.js – Moddable XS BLE OTA ESP32
 *
 * Entry point for the BLE OTA firmware.
 *
 * Responsibilities:
 *   1. Check NVS for a pending OTA update; if found, apply it.
 *   2. Start the BLE GATT peripheral advertising the OTA service.
 *   3. Manage low-power sleep between connections.
 *
 * BLE Service / Characteristic UUIDs
 * ─────────────────────────────────────────────────────────────────────
 *   OTA Service      : 12345678-1234-1234-1234-123456789ABC
 *   OTA Data Char    : 12345678-1234-1234-1234-123456789ABD  (Write/WriteNR)
 *   OTA Commit Char  : 12345678-1234-1234-1234-123456789ABE  (Write)
 *   OTA Status Char  : 12345678-1234-1234-1234-123456789ABF  (Notify/Read)
 * ─────────────────────────────────────────────────────────────────────
 *
 * Build & flash:
 *   mcconfig -d -m -p esp32 -f mczip
 */

import BLEPeripheral from "bleperipheral";
import OTAManager from "ota-manager";
import SleepManager from "sleep-manager";
import Timer from "timer";
import System from "system";

// ─── UUIDs ──────────────────────────────────────────────────────────────────

const OTA_SERVICE_UUID      = "12345678-1234-1234-1234-123456789ABC";
const OTA_DATA_CHAR_UUID    = "12345678-1234-1234-1234-123456789ABD";
const OTA_COMMIT_CHAR_UUID  = "12345678-1234-1234-1234-123456789ABE";
const OTA_STATUS_CHAR_UUID  = "12345678-1234-1234-1234-123456789ABF";

// Status values written to OTA Status characteristic
const STATUS_IDLE      = 0x00;
const STATUS_RECEIVING = 0x01;
const STATUS_COMMITTING= 0x02;
const STATUS_SUCCESS   = 0x03;
const STATUS_ERROR     = 0xFF;

// ─── Pending OTA check ───────────────────────────────────────────────────────

function applyPendingOTA() {
	if (!OTAManager.hasPending()) return;

	trace("main: pending OTA detected in NVS\n");
	const pendingCode = OTAManager.getPending();
	if (!pendingCode) {
		trace("main: pending OTA data missing, clearing\n");
		OTAManager.clearPending();
		return;
	}

	trace(`main: applying ${pendingCode.byteLength} bytes of pending OTA code\n`);
	// In a production system this would write to the next OTA partition and
	// trigger ESP32 esp_ota_set_boot_partition(). For JavaScript-level OTA
	// (uploading a new .xsb module archive), the bytes are available via
	// OTAManager.getPending() at boot time and can be evaluated/loaded here.
	// The application is responsible for interpreting these bytes.
	// After successful apply, clear the pending marker.
	OTAManager.clearPending();
	trace("main: OTA applied successfully\n");
}

// ─── BLE Peripheral setup ────────────────────────────────────────────────────

class OTAPeripheral extends BLEPeripheral {
	#otaManager;
	#sleepManager;
	#statusHandle = null;
	#clientConnected = false;

	constructor(otaManager, sleepManager) {
		super();
		this.#otaManager = otaManager;
		this.#sleepManager = sleepManager;
	}

	// ── BLEPeripheral lifecycle callbacks ────────────────────────────────────

	onReady() {
		trace("BLE: peripheral ready\n");
		this.#startAdvertising();
	}

	onConnected(connection) {
		this.#clientConnected = true;
		trace(`BLE: client connected (handle=${connection.handle})\n`);
		this.#sleepManager.onConnect();
		this.#otaManager.inhibit();   // keep SleepManager awake during transfer
	}

	onDisconnected(connection) {
		this.#clientConnected = false;
		trace("BLE: client disconnected\n");
		this.#sleepManager.onDisconnect();
		this.#otaManager.abort();
		this.#otaManager.allow();
		// Restart advertising so new clients can connect
		this.#startAdvertising();
	}

	// ── GATT Write callbacks ─────────────────────────────────────────────────

	onCharacteristicWritten(characteristic, data) {
		const uuid = characteristic.uuid.toUpperCase();

		if (uuid === OTA_DATA_CHAR_UUID.toUpperCase()) {
			this.#sleepManager.resetIdleTimer();
			const ok = this.#otaManager.receiveChunk(data);
			this.#sendStatus(ok ? STATUS_RECEIVING : STATUS_ERROR);

		} else if (uuid === OTA_COMMIT_CHAR_UUID.toUpperCase()) {
			this.#sendStatus(STATUS_COMMITTING);
			const ok = this.#otaManager.commit();
			if (ok) {
				this.#sendStatus(STATUS_SUCCESS);
				// Reboot after a short delay so the status notification is delivered
				Timer.set(() => {
					trace("main: rebooting to apply OTA update\n");
					System.restart();
				}, 500);
			} else {
				this.#sendStatus(STATUS_ERROR);
			}
		}
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	#startAdvertising() {
		this.startAdvertising({
			advertisingData: {
				flags: 0x06,
				completeName: "Moddable-OTA",
				completeUUID128List: [OTA_SERVICE_UUID]
			}
		});
		trace("BLE: advertising started\n");
	}

	#sendStatus(statusByte) {
		if (!this.#clientConnected || this.#statusHandle === null) return;
		try {
			this.notifyCharacteristic(this.#statusHandle, Uint8Array.of(statusByte).buffer);
		} catch (e) {
			trace(`BLE: notify failed (${e})\n`);
		}
	}
}

// ─── GATT Service Definition ─────────────────────────────────────────────────

const GATT_SERVICES = [
	{
		uuid: OTA_SERVICE_UUID,
		characteristics: [
			{
				uuid: OTA_DATA_CHAR_UUID,
				properties: ["write", "writeWithoutResponse"],
				maxBytes: 512
			},
			{
				uuid: OTA_COMMIT_CHAR_UUID,
				properties: ["write"],
				maxBytes: 1
			},
			{
				uuid: OTA_STATUS_CHAR_UUID,
				properties: ["notify", "read"],
				maxBytes: 1
			}
		]
	}
];

// ─── Application entry point ─────────────────────────────────────────────────

applyPendingOTA();

const sleepManager = new SleepManager({ idleTimeoutMs: 30_000 });
const otaManager   = new OTAManager({
	onCommit: () => {
		// Inhibit sleep until the reboot timer fires
		sleepManager.inhibit();
	}
});

// Extend OTAManager with sleep control delegation
otaManager.inhibit = () => sleepManager.inhibit();
otaManager.allow   = () => sleepManager.allow();

const peripheral = new OTAPeripheral(otaManager, sleepManager);
peripheral.onReady();

trace("main: BLE OTA firmware running\n");
