/*
 * Sleep Manager for Moddable XS BLE OTA ESP32
 *
 * Manages ESP32 light sleep and deep sleep modes.
 * The device stays awake while a BLE connection is active and enters
 * light sleep during idle advertising periods to conserve battery.
 *
 * Wake sources:
 *   - BLE connection event (hardware managed by ESP32 BLE controller)
 *   - GPIO pin (optional external wake, e.g., user button on pin 0)
 *   - Timer (configurable idle timeout)
 */

import Timer from "timer";
import { Sleep } from "sleep";   // Moddable embedded:sleep or esp32-specific

const DEFAULT_IDLE_TIMEOUT_MS = 30_000; // 30 s idle before sleep
const DEEP_SLEEP_TIMEOUT_MS   = 300_000; // 5 min before deep sleep

export default class SleepManager {
	#idleTimer = null;
	#deepSleepTimer = null;
	#connected = false;
	#sleepEnabled = true;
	#idleTimeoutMs;

	constructor({ idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = {}) {
		this.#idleTimeoutMs = idleTimeoutMs;
	}

	// Call when a BLE connection is established
	onConnect() {
		this.#connected = true;
		this.#cancelTimers();
		trace("SleepManager: BLE connected – sleep inhibited\n");
	}

	// Call when a BLE connection is dropped
	onDisconnect() {
		this.#connected = false;
		trace("SleepManager: BLE disconnected – starting idle timer\n");
		this.#startIdleTimer();
	}

	// Call periodically or on any BLE activity to reset the idle timer
	resetIdleTimer() {
		if (!this.#connected) this.#startIdleTimer();
	}

	// Disable automatic sleep (e.g., during OTA transfer)
	inhibit() {
		this.#sleepEnabled = false;
		this.#cancelTimers();
		trace("SleepManager: sleep inhibited by caller\n");
	}

	// Re-enable automatic sleep after inhibit()
	allow() {
		this.#sleepEnabled = true;
		if (!this.#connected) this.#startIdleTimer();
		trace("SleepManager: sleep allowed\n");
	}

	// --- Private ---

	#startIdleTimer() {
		this.#cancelTimers();
		if (!this.#sleepEnabled) return;

		trace(`SleepManager: idle timer set for ${this.#idleTimeoutMs} ms\n`);

		this.#idleTimer = Timer.set(() => {
			trace("SleepManager: idle timeout – entering light sleep\n");
			this.#enterLightSleep();
		}, this.#idleTimeoutMs);

		this.#deepSleepTimer = Timer.set(() => {
			trace("SleepManager: deep-sleep timeout – entering deep sleep\n");
			this.#enterDeepSleep();
		}, DEEP_SLEEP_TIMEOUT_MS);
	}

	#cancelTimers() {
		if (this.#idleTimer !== null) {
			Timer.clear(this.#idleTimer);
			this.#idleTimer = null;
		}
		if (this.#deepSleepTimer !== null) {
			Timer.clear(this.#deepSleepTimer);
			this.#deepSleepTimer = null;
		}
	}

	// Light sleep: keeps RAM, BLE controller can wake the CPU
	#enterLightSleep() {
		try {
			// duration 0 means sleep until wake event (BLE controller wakes CPU)
			Sleep.light(0);
			trace("SleepManager: woke from light sleep\n");
			// After waking, restart idle timer
			this.#startIdleTimer();
		} catch (e) {
			trace(`SleepManager: light sleep not available (${e})\n`);
		}
	}

	// Deep sleep: lowest power, loses RAM state; BLE re-initialises on wakeup
	// Typically used after extended idle with no connections expected soon.
	#enterDeepSleep() {
		this.#cancelTimers();
		try {
			trace("SleepManager: entering deep sleep – wake on GPIO 0 or timer\n");
			// Wake after 60 s or on GPIO 0 falling edge (user button / external signal)
			Sleep.deep(60_000);
		} catch (e) {
			trace(`SleepManager: deep sleep not available (${e})\n`);
		}
	}
}
