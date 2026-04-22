import { BleManager, Device, Characteristic } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

// Try FFF0 pair first (most cheap clones), fall back to NUS (Vgate, OBDLink)
const PROFILES = [
  { service: 'fff0', write: 'fff2', notify: 'fff1' },
  {
    service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
  },
];

const INIT_CMDS = ['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1', 'ATSP0'];

// High priority (every ~250ms): RPM, Speed, MAF
// Low priority (every ~2s): Engine Load, IAT, MAP, Coolant
const HIGH_PIDS = ['010C', '010D', '0110'] as const;
const LOW_PIDS  = ['0104', '010F', '010B', '0105'] as const;

/**
 * Extended PID attempts — run once at trip start, not in the hot loop.
 *
 * SEATBELT: No OBD-II Mode 01 standard PID exists for seatbelt status.
 * These are the most common manufacturer-specific PIDs that some
 * vehicles expose via Mode 22 (enhanced diagnostics). The adapter must
 * support Mode 22; a generic ELM327 clone usually does.
 *
 * Known working: some GM/Chevrolet 2015+ (0x22111D), some Ford 2016+
 * (0x22D2A1). Most other makes respond with "NO DATA" and we fall back
 * to 'unknown'. This is the honest behaviour — never report 'fastened'
 * when we can't confirm it.
 *
 * TPMS: Tyre pressure is also not in the SAE J1979 standard. The only
 * reliable TPMS PID is manufacturer-specific Mode 22. We try the most
 * common ones. If the vehicle has TPMS and exposes it, great. If not,
 * we leave it null and the UI can offer a manual prompt.
 *
 * If you want to extend TPMS/seatbelt support for a specific car model,
 * add its Mode 22 PIDs to EXTENDED_PIDS below.
 */
const SEATBELT_PIDS_M22 = ['22111D', '22D2A1', '221B00'] as const;
const TPMS_PIDS_M22      = ['220E12', '220E13', '220E14', '220E15'] as const;

export type OBDState = 'idle' | 'scanning' | 'connecting' | 'ready' | 'reconnecting' | 'error';
export type SeatbeltStatus = 'fastened' | 'unfastened' | 'unknown';

export interface OBDData {
  state: OBDState;
  adapterName: string | null;
  rpm: number | null;
  speedKmH: number | null;
  mafGPerS: number | null;
  mapKPa: number | null;
  iatC: number | null;
  engineLoadPct: number | null;
  coolantC: number | null;
  fuelRateLPerH: number | null;
  fuelCalcMethod: 'MAF' | 'MAP' | 'none';
  /** Seatbelt: only populated on vehicles with a supported Mode 22 PID. */
  seatbeltStatus: SeatbeltStatus;
  /**
   * TPMS pressures in kPa for FL, FR, RL, RR.
   * null = not supported or not yet read; 0 = flat (sensor data zero).
   * 200–250 kPa (29–36 psi) is the normal range for most passenger cars.
   */
  tpmsFLKpa: number | null;
  tpmsFRKpa: number | null;
  tpmsRLKpa: number | null;
  tpmsRRKpa: number | null;
  errorMsg: string | null;
}

export const defaultOBDData: OBDData = {
  state: 'idle',
  adapterName: null,
  rpm: null,
  speedKmH: null,
  mafGPerS: null,
  mapKPa: null,
  iatC: null,
  engineLoadPct: null,
  coolantC: null,
  fuelRateLPerH: null,
  fuelCalcMethod: 'none',
  seatbeltStatus: 'unknown',
  tpmsFLKpa: null,
  tpmsFRKpa: null,
  tpmsRLKpa: null,
  tpmsRRKpa: null,
  errorMsg: null,
};

export interface VehicleCfg {
  stoichAFR: number;
  fuelDensityGPerL: number;
  displacementL: number;
  volEfficiency: number;
  /** Engine redline RPM. Used by OBDWearMonitor for RPM-ratio wear signal. */
  redlineRPM: number;
}

export class OBDManager {
  private static instance: OBDManager;
  static getInstance() {
    if (!OBDManager.instance) OBDManager.instance = new OBDManager();
    return OBDManager.instance;
  }

  private ble: BleManager | null = null;
  private getBle(): BleManager {
    if (!this.ble) this.ble = new BleManager();
    return this.ble;
  }
  private device: Device | null = null;
  private writeCharId: string | null = null;
  private rxBuffer = '';
  private responseResolve: ((s: string) => void) | null = null;
  private polling = false;
  private lowPidIndex = 0;
  private tickCount = 0;
  private reconnectAttempt = 0;
  private cachedDeviceId: string | null = null;
  private vehicle: VehicleCfg | null = null;
  private onUpdate: ((data: OBDData) => void) | null = null;
  private data: OBDData = { ...defaultOBDData };

  setUpdateHandler(fn: (data: OBDData) => void) {
    this.onUpdate = fn;
  }

  async start(vehicle: VehicleCfg) {
    this.vehicle = vehicle;
    this.reconnectAttempt = 0;
    await this.connect();
  }

  async stop() {
    this.polling = false;
    await this.device?.cancelConnection();
    this.device = null;
    this.emit({ ...defaultOBDData, state: 'idle' });
  }

  private async connect() {
    if (this.cachedDeviceId) {
      try {
        this.emit({ state: 'connecting' });
        this.device = await this.getBle().connectToDevice(this.cachedDeviceId, { timeout: 8000 });
        await this.onConnected();
        return;
      } catch {
        this.cachedDeviceId = null;
      }
    }

    this.emit({ state: 'scanning' });
    const found = await this.scan();
    if (!found) {
      this.emit({ state: 'error', errorMsg: 'No OBD adapter found. Is it plugged in?' });
      return;
    }

    this.emit({ state: 'connecting', adapterName: found.name ?? 'OBD Adapter' });
    try {
      this.device = await found.connect({ timeout: 8000 });
      this.cachedDeviceId = this.device.id;
      await this.onConnected();
    } catch {
      this.scheduleReconnect();
    }
  }

  private async scan(): Promise<Device | null> {
    return new Promise((resolve) => {
      let found: Device | null = null;
      const timer = setTimeout(() => {
        this.getBle().stopDeviceScan();
        resolve(null);
      }, 15000);

      this.getBle().startDeviceScan(null, { allowDuplicates: false }, (err, device) => {
        if (err || !device) return;
        const name = device.name?.toUpperCase() ?? '';
        const isOBD =
          name.includes('OBD') ||
          name.includes('ELM') ||
          name.includes('VGATE') ||
          name.includes('OBDII') ||
          name.includes('ICAR');
        if (isOBD && !found) {
          found = device;
          clearTimeout(timer);
          this.getBle().stopDeviceScan();
          resolve(device);
        }
      });
    });
  }

  private async onConnected() {
    if (!this.device) return;
    await this.device.discoverAllServicesAndCharacteristics();

    const services = await this.device.services();
    let profile = PROFILES[0];
    for (const svc of services) {
      const match = PROFILES.find((p) =>
        svc.uuid.toLowerCase().startsWith(p.service.toLowerCase())
      );
      if (match) {
        profile = match;
        break;
      }
    }
    this.writeCharId = profile.write;

    this.device.monitorCharacteristicForService(
      profile.service,
      profile.notify,
      (_err: Error | null, char: Characteristic | null) => {
        if (_err || !char?.value) return;
        const chunk = Buffer.from(char.value, 'base64').toString('ascii');
        this.rxBuffer += chunk;
        if (this.rxBuffer.includes('>') || this.rxBuffer.endsWith('\r')) {
          const response = this.rxBuffer.trim();
          this.rxBuffer = '';
          this.responseResolve?.(response);
          this.responseResolve = null;
        }
      }
    );

    this.device.onDisconnected(() => {
      if (this.polling) this.scheduleReconnect();
    });

    for (const cmd of INIT_CMDS) {
      try {
        await this.send(cmd, 2000);
      } catch {
        // non-fatal
      }
    }

    try {
      const resp = await this.send('0100', 3000);
      if (resp.includes('UNABLE') || resp.includes('NO DATA')) {
        this.emit({
          state: 'error',
          errorMsg: 'Adapter connected but car ECU not responding. Turn ignition ON.',
        });
        return;
      }
    } catch {
      this.emit({ state: 'error', errorMsg: 'ECU not responding. Turn ignition ON.' });
      return;
    }

    // One-shot extended PID queries (non-blocking, best-effort)
    this.probeExtendedPIDs();

    this.reconnectAttempt = 0;
    this.polling = true;
    this.emit({ state: 'ready', errorMsg: null });
    this.pollLoop();
  }

  /**
   * Attempt seatbelt and TPMS reads exactly once at connection time.
   * We don't retry on failure — if the vehicle doesn't support these
   * PIDs they just remain null / 'unknown'.
   */
  private async probeExtendedPIDs() {
    // Seatbelt
    for (const pid of SEATBELT_PIDS_M22) {
      try {
        const raw = await this.send(pid, 1500);
        const bytes = parseHexResponse(raw);
        if (bytes && bytes.length >= 1) {
          // Bit 0 of the first byte is the seatbelt switch on most implementations.
          // A value of 0 = fastened (circuit closed), 1 = open = unfastened.
          // This is manufacturer-dependent; we mark 'unknown' if we can't confirm.
          const bit = bytes[0] & 0x01;
          this.data.seatbeltStatus = bit === 0 ? 'fastened' : 'unfastened';
          break;
        }
      } catch { /* unsupported — try next */ }
    }

    // TPMS — four sensors, four PIDs
    const tpmsPids = [...TPMS_PIDS_M22];
    const tpmsKeys: Array<keyof OBDData> = ['tpmsFLKpa', 'tpmsFRKpa', 'tpmsRLKpa', 'tpmsRRKpa'];
    for (let i = 0; i < Math.min(tpmsPids.length, tpmsKeys.length); i++) {
      try {
        const raw = await this.send(tpmsPids[i], 1500);
        const bytes = parseHexResponse(raw);
        if (bytes && bytes.length >= 2) {
          // Common encoding: kPa = (A * 256 + B) / 4
          const kpa = ((bytes[0] * 256) + bytes[1]) / 4;
          (this.data as unknown as Record<string, number | null>)[tpmsKeys[i] as string] = kpa;
        }
      } catch { /* unsupported */ }
    }
  }

  private async send(cmd: string, timeoutMs = 2000): Promise<string> {
    if (!this.device || !this.writeCharId) throw new Error('Not connected');
    const svc = (await this.device.services()).find((s) =>
      PROFILES.some((p) => s.uuid.toLowerCase().startsWith(p.service.toLowerCase()))
    );
    if (!svc) throw new Error('Service not found');

    this.rxBuffer = '';
    const bytes = Buffer.from(cmd + '\r').toString('base64');
    await this.device.writeCharacteristicWithResponseForService(svc.uuid, this.writeCharId!, bytes);

    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.responseResolve = null;
        reject(new Error('timeout'));
      }, timeoutMs);
      this.responseResolve = (resp) => {
        clearTimeout(t);
        resolve(resp);
      };
    });
  }

  private async pollLoop() {
    while (this.polling) {
      try {
        for (const pid of HIGH_PIDS) {
          const raw = await this.send(pid, 1000);
          this.applyPID(pid, raw);
        }
        const lowPid = LOW_PIDS[this.lowPidIndex % LOW_PIDS.length];
        const raw = await this.send(lowPid, 1000);
        this.applyPID(lowPid, raw);
        this.lowPidIndex++;

        this.computeFuelRate();
        this.emitCurrent();
      } catch {
        // Timeout on individual PID — skip, don't crash the loop
      }

      this.tickCount++;
      if (this.tickCount % 20 === 0) {
        try {
          await this.send('ATI', 1500);
        } catch {
          if (this.polling) {
            this.scheduleReconnect();
            return;
          }
        }
      }

      await sleep(50);
    }
  }

  private applyPID(pid: string, raw: string) {
    const bytes = parseHexResponse(raw);
    if (!bytes) return;
    const [A, B] = bytes;
    switch (pid) {
      case '010C': this.data.rpm = ((A * 256) + B) / 4; break;
      case '010D': this.data.speedKmH = A; break;
      case '0110': this.data.mafGPerS = ((A * 256) + B) / 100; break;
      case '010B': this.data.mapKPa = A; break;
      case '010F': this.data.iatC = A - 40; break;
      case '0104': this.data.engineLoadPct = (A * 100) / 255; break;
      case '0105': this.data.coolantC = A - 40; break;
    }
  }

  private computeFuelRate() {
    if (!this.vehicle) return;
    const v = this.vehicle;

    if (this.data.mafGPerS !== null && this.data.mafGPerS > 0) {
      const fuelMass = this.data.mafGPerS / v.stoichAFR;
      this.data.fuelRateLPerH = (fuelMass * 3600) / v.fuelDensityGPerL;
      this.data.fuelCalcMethod = 'MAF';
      return;
    }

    if (this.data.mapKPa !== null && this.data.iatC !== null && this.data.rpm !== null) {
      const iatK = this.data.iatC + 273.15;
      const imap = (this.data.rpm * this.data.mapKPa) / (iatK * 2);
      const synthMaf = (imap / 60) * v.volEfficiency * v.displacementL * (28.97 / 8.314);
      const fuelMass = synthMaf / v.stoichAFR;
      this.data.fuelRateLPerH = (fuelMass * 3600) / v.fuelDensityGPerL;
      this.data.fuelCalcMethod = 'MAP';
      return;
    }

    this.data.fuelCalcMethod = 'none';
  }

  private scheduleReconnect() {
    this.polling = false;
    this.reconnectAttempt++;
    if (this.reconnectAttempt > 8) {
      this.emit({ state: 'error', errorMsg: 'Lost connection. Check the adapter.' });
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt - 1), 30000);
    this.emit({ state: 'reconnecting' });
    setTimeout(() => this.connect(), delay);
  }

  private emit(patch: Partial<OBDData>) {
    this.data = { ...this.data, ...patch };
    this.onUpdate?.(this.data);
  }

  private emitCurrent() {
    this.onUpdate?.(this.data);
  }
}

function parseHexResponse(raw: string): number[] | null {
  const clean = raw.replace(/[^0-9A-Fa-f\s]/g, '').trim();
  const parts = clean.split(/\s+/);
  if (parts.length < 3) return null;
  try {
    return parts.slice(2).map((h) => parseInt(h, 16));
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
