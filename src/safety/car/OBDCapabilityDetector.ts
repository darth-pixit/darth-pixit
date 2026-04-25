/**
 * OBDCapabilityDetector — probes manufacturer-specific OBD-II PIDs at
 * first pairing to discover what the vehicle actually supports.
 *
 * Why probe at pairing instead of assuming standard PIDs:
 *   OBD-II mandates only a subset of PIDs. Seatbelt state, gear position,
 *   and even throttle position are absent on many economy vehicles. Probing
 *   once and caching the result (keyed by vehicleId/VIN) prevents the engine
 *   from polling unsupported PIDs on every trip.
 *
 * How it works:
 *   The caller supplies a `sendPID` function that dispatches an OBD command
 *   and returns the raw response string (or null on timeout/error). We test
 *   a small set of known PIDs and record which ones return valid responses.
 *
 * Standard PIDs tested:
 *   0111 — Throttle Position (Mode 01, PID 11)
 *          Returns 1-byte value 0x00–0xFF. "NO DATA" or timeout = unsupported.
 *
 *   01A4 — Transmission Gear (Mode 01, PID A4)
 *          Only on modern CAN-equipped vehicles (2010+). Returns gear number.
 *
 * Manufacturer-specific seatbelt PID:
 *   There is no standard OBD-II seatbelt PID. The most common approaches:
 *     GM:     Mode 22, PID 0118 (seat belt status byte)
 *     Ford:   Mode 22, PID 4813 (restraint system status)
 *     Toyota: Mode 21, PID 0101 (body control module byte 1, bit 5)
 *     Honda:  Mode 21, PID 01 (varies by platform)
 *   We test a configurable list of candidate PIDs and use the first one
 *   that returns a parseable response.
 *
 * Results are persisted externally (caller saves VehicleCapabilities) so
 * probing doesn't repeat on every reconnect.
 */

import { VehicleCapabilities } from './types';

/** Function provided by the caller to dispatch one OBD query. */
export type OBDProbeFn = (pid: string) => Promise<string | null>;

/** PIDs tried (in order) to detect seatbelt support. */
const SEATBELT_PROBE_PIDS: string[] = [
  '220118',  // GM Mode 22, PID 0118
  '224813',  // Ford Mode 22, PID 4813
  '210101',  // Toyota Mode 21, PID 0101
  '2101',    // Honda / generic Mode 21 PID 01
];

const THROTTLE_PID  = '0111';  // Mode 01, PID 11 — Throttle Position
const GEAR_PID      = '01A4';  // Mode 01, PID A4 — Transmission Gear

/** Timeout for a single PID probe, ms. */
const PROBE_TIMEOUT_MS = 1500;

export class OBDCapabilityDetector {
  /**
   * Probe the vehicle for supported PIDs. Should be called once per
   * vehicle after the OBD adapter reports `connected` state, before
   * the first trip starts.
   *
   * @param vehicleId  VIN or user-assigned ID (used as cache key).
   * @param sendPID    Caller-supplied OBD dispatch function.
   */
  async probe(vehicleId: string, sendPID: OBDProbeFn): Promise<VehicleCapabilities> {
    const [throttleSupported, gearSupported, seatbeltPid] = await Promise.all([
      this.testPID(sendPID, THROTTLE_PID),
      this.testPID(sendPID, GEAR_PID),
      this.detectSeatbeltPid(sendPID),
    ]);

    return {
      vehicleId,
      seatbeltPidSupported: seatbeltPid !== null,
      throttlePidSupported: throttleSupported,
      gearPidSupported: gearSupported,
      probedAt: Date.now(),
    };
  }

  private async testPID(sendPID: OBDProbeFn, pid: string): Promise<boolean> {
    try {
      const result = await withTimeout(sendPID(pid), PROBE_TIMEOUT_MS);
      return isValidOBDResponse(result, pid.slice(0, 2));
    } catch {
      return false;
    }
  }

  private async detectSeatbeltPid(sendPID: OBDProbeFn): Promise<string | null> {
    for (const pid of SEATBELT_PROBE_PIDS) {
      try {
        const result = await withTimeout(sendPID(pid), PROBE_TIMEOUT_MS);
        const mode = pid.slice(0, 2);
        if (isValidOBDResponse(result, mode)) return pid;
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }
}

/**
 * Checks if an OBD response looks like a valid data frame for the given
 * mode. A "NO DATA", "ERROR", null, or empty string means unsupported.
 *
 * Expected positive response format: mode+0x40 prefix followed by data
 * bytes (hex). For example, mode "01" PID "11" returns "41 11 7B" for
 * a throttle at ~48%.
 */
function isValidOBDResponse(response: string | null, mode: string): boolean {
  if (!response) return false;
  const upper = response.toUpperCase().trim();
  if (upper.includes('NO DATA') || upper.includes('ERROR') ||
      upper.includes('UNABLE') || upper.includes('?') ||
      upper.length === 0) {
    return false;
  }
  // Positive response mode = mode byte + 0x40.
  const positiveMode = (parseInt(mode, 16) + 0x40).toString(16).toUpperCase().padStart(2, '0');
  return upper.startsWith(positiveMode) || upper.includes(positiveMode);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('probe timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
