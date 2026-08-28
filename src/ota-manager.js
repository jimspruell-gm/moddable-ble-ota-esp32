/*
 * OTA Manager for Moddable XS BLE OTA ESP32
 *
 * Manages receiving firmware/code chunks over BLE and storing them in
 * NVS (Preferences) flash storage. On "commit", the device reboots and
 * the new code is loaded from storage.
 *
 * BLE Service UUID  : config.ota_service_uuid
 * OTA Data Char UUID: config.ota_data_char_uuid   (Write / Write No Response)
 * OTA Commit UUID   : config.ota_commit_char_uuid  (Write)
 */

import Preference from "preference";

const MAX_OTA_SIZE = 65536; // 64 KB max stored code

export default class OTAManager {
	#chunks = [];
	#totalBytes = 0;
	#active = false;
	#onCommitCallback;

	constructor({ onCommit } = {}) {
		this.#onCommitCallback = onCommit ?? (() => {});
	}

	// Called by the BLE peripheral when a write arrives on the OTA Data characteristic.
	receiveChunk(data) {
		if (!this.#active) {
			this.#active = true;
			this.#chunks = [];
			this.#totalBytes = 0;
			trace("OTA: transfer started\n");
		}

		if (this.#totalBytes + data.byteLength > MAX_OTA_SIZE) {
			trace(`OTA: payload exceeds max size (${MAX_OTA_SIZE} bytes), aborting\n`);
			this.abort();
			return false;
		}

		// Copy chunk bytes into a plain Uint8Array for safe storage
		const view = new Uint8Array(data);
		const copy = new Uint8Array(view.byteLength);
		for (let i = 0; i < view.byteLength; i++) copy[i] = view[i];
		this.#chunks.push(copy);
		this.#totalBytes += copy.byteLength;

		trace(`OTA: received chunk ${copy.byteLength} bytes, total ${this.#totalBytes}\n`);
		return true;
	}

	// Called by the BLE peripheral when a write arrives on the OTA Commit characteristic.
	commit() {
		if (!this.#active || this.#chunks.length === 0) {
			trace("OTA: commit called but no transfer in progress\n");
			return false;
		}

		trace(`OTA: committing ${this.#totalBytes} bytes\n`);

		// Assemble all chunks into a single buffer
		const combined = new Uint8Array(this.#totalBytes);
		let offset = 0;
		for (const chunk of this.#chunks) {
			for (let i = 0; i < chunk.byteLength; i++) combined[offset++] = chunk[i];
		}

		// Persist to NVS via Moddable Preference module
		// Key layout: domain="ota", key="pending" → ArrayBuffer
		try {
			Preference.set("ota", "pending", combined.buffer);
			Preference.set("ota", "pendingSize", this.#totalBytes);
			trace("OTA: code stored in NVS, rebooting…\n");
			this.#active = false;
			this.#chunks = [];
			this.#totalBytes = 0;
			this.#onCommitCallback();
			return true;
		} catch (e) {
			trace(`OTA: failed to write NVS: ${e}\n`);
			this.abort();
			return false;
		}
	}

	// Discard any in-progress transfer
	abort() {
		this.#active = false;
		this.#chunks = [];
		this.#totalBytes = 0;
		trace("OTA: transfer aborted\n");
	}

	// Check whether a pending update is stored in NVS
	static hasPending() {
		return Preference.get("ota", "pendingSize") > 0;
	}

	// Retrieve pending update bytes from NVS (returns ArrayBuffer or undefined)
	static getPending() {
		return Preference.get("ota", "pending");
	}

	// Clear the pending update from NVS (call after successful apply)
	static clearPending() {
		Preference.delete("ota", "pending");
		Preference.delete("ota", "pendingSize");
		trace("OTA: pending update cleared from NVS\n");
	}
}
