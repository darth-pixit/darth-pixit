import { BleManager, Device, Characteristic } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

// Known service UUIDs for common adapter families, ranked by how widespread they are.
// We still auto-detect write+notify characteristics so unknown clones also work.
const KNOWN_SERVICES = [
  'fff0', // most cheap FFF0/FFF1/FFF2 clones
  'ffe0', // HM-10 pattern (single FFE1 char) — very common on sub-$10 clones
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART (Vgate, OBDLink)
  '18f0', // some ELM327 clones
];

// ATS0 (no spaces) was removed — it makes ELM327 concatenate hex bytes, breaking our
// parsers. Default ELM327 behavior (spaces between bytes) is what we expect.
const INIT_CMDS = ['ATZ', 'ATE0', 'ATL0', 'ATH0', 'ATAT1', 'ATSP0'];

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
  debugLog: string[];
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
  debugLog: [],
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
  private serviceUuid: string | null = null;
  private writeCharId: string | null = null;
  private writeWithResponse = true;
  private rxBuffer = '';
  private responseResolve: ((s: string) => void) | null = null;
  private active = false;
  private polling = false;
  private lowPidIndex = 0;
  private tickCount = 0;
  private reconnectAttempt = 0;
  private cachedDeviceId: string | null = null;
  private vehicle: VehicleCfg | null = null;
  private onUpdate: ((data: OBDData) => void) | null = null;
  private data: OBDData = { ...defaultOBDData, debugLog: [] };
  private logBuf: string[] = [];

  private log(msg: string) {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] ${msg}`;
    console.log('[OBD]', line);
    this.logBuf.push(line);
    if (this.logBuf.length > 80) this.logBuf.splice(0, this.logBuf.length - 80);
    this.data = { ...this.data, debugLog: [...this.logBuf] };
    this.onUpdate?.(this.data);
  }

  setUpdateHandler(fn: (data: OBDData) => void) {
    this.onUpdate = fn;
  }

  async start(vehicle: VehicleCfg) {
    this.active = true;
    this.vehicle = vehicle;
    this.reconnectAttempt = 0;
    this.logBuf = [];
    this.log('start()');
    await this.connect();
  }

  async stop() {
    this.active = false;
    this.log('stop()');
    this.polling = false;
    this.responseResolve = null;
    this.rxBuffer = '';
    await this.device?.cancelConnection();
    this.device = null;
    this.serviceUuid = null;
    this.writeCharId = null;
    this.emit({ ...defaultOBDData, state: 'idle', debugLog: [...this.logBuf] });
  }

  private async waitForPoweredOn(timeoutMs = 8000): Promise<boolean> {
    const state = await this.getBle().state();
    this.log(`BLE state: ${state}`);
    if (state === 'PoweredOn') return true;
    if (state === 'Unauthorized') {
      this.emit({
        state: 'error',
        errorMsg: 'Bluetooth permission denied. Enable it in Settings → DarthPixit → Bluetooth.',
      });
      return false;
    }
    if (state === 'Unsupported') {
      this.emit({ state: 'error', errorMsg: 'BLE not supported on this device.' });
      return false;
    }

    return new Promise((resolve) => {
      const sub = this.getBle().onStateChange((s) => {
        this.log(`BLE state change: ${s}`);
        if (s === 'PoweredOn') {
          sub.remove();
          clearTimeout(timer);
          resolve(true);
        }
        if (s === 'Unauthorized' || s === 'Unsupported') {
          sub.remove();
          clearTimeout(timer);
          this.emit({
            state: 'error',
            errorMsg:
              s === 'Unauthorized'
                ? 'Bluetooth permission denied. Enable it in Settings.'
                : 'BLE not supported on this device.',
          });
          resolve(false);
        }
      }, true);
      const timer = setTimeout(() => {
        sub.remove();
        this.emit({
          state: 'error',
          errorMsg: 'Bluetooth is off. Turn it on and try again.',
        });
        resolve(false);
      }, timeoutMs);
    });
  }

  private async connect() {
    if (!(await this.waitForPoweredOn())) return;

    if (this.cachedDeviceId) {
      try {
        this.emit({ state: 'connecting' });
        this.log(`reconnecting to cached ${this.cachedDeviceId}`);
        this.device = await this.getBle().connectToDevice(this.cachedDeviceId, { timeout: 8000 });
        await this.onConnected();
        return;
      } catch (e: any) {
        this.log(`cached reconnect failed: ${e?.message ?? e}`);
        this.cachedDeviceId = null;
      }
    }

    this.emit({ state: 'scanning' });
    this.log('scanning for OBD adapter (15s)');
    const found = await this.scan();
    if (!found) {
      this.emit({
        state: 'error',
        errorMsg:
          'No BLE OBD adapter found. iOS requires a BLE (BT 4.0+) adapter — ' +
          'cheap "Bluetooth" ELM327 clones are usually Bluetooth Classic and ' +
          'invisible to iOS apps.',
      });
      return;
    }

    this.emit({ state: 'connecting', adapterName: found.name ?? 'OBD Adapter' });
    try {
      this.device = await found.connect({ timeout: 8000 });
      this.cachedDeviceId = this.device.id;
      await this.onConnected();
    } catch (e: any) {
      this.log(`connect/onConnected failed: ${e?.message ?? e}`);
      this.scheduleReconnect();
    }
  }

  private async scan(): Promise<Device | null> {
    return new Promise((resolve) => {
      let found: Device | null = null;
      const timer = setTimeout(() => {
        this.getBle().stopDeviceScan();
        this.log('scan: no OBD adapter found after 15s');
        resolve(null);
      }, 15000);

      this.getBle().startDeviceScan(null, { allowDuplicates: false }, (err, device) => {
        if (err) {
          this.log(`scan error: ${err.message ?? err}`);
          return;
        }
        if (!device) return;
        const rawName = device.name ?? device.localName ?? '';
        const name = rawName.toUpperCase();
        // Log every named device we see, to help identify what's around.
        if (rawName) this.log(`  saw "${rawName}" id=${device.id}`);
        const isOBD =
          name.includes('OBD') ||
          name.includes('ELM') ||
          name.includes('VGATE') ||
          name.includes('OBDII') ||
          name.includes('ICAR') ||
          name.includes('VEEPEAK') ||
          name.includes('KONNWEI') ||
          name.includes('VIECAR') ||
          name.includes('CARLY') ||
          name.includes('CARISTA') ||
          name.includes('BLE-OBD') ||
          name.includes('V-LINK') ||
          name.startsWith('IOS-VLINK');
        if (isOBD && !found) {
          found = device;
          this.log(`scan: matched "${rawName}" id=${device.id}`);
          clearTimeout(timer);
          this.getBle().stopDeviceScan();
          resolve(device);
        }
      });
    });
  }

  private async onConnected() {
    if (!this.device) return;
    this.log('connected; discovering services');
    await this.device.discoverAllServicesAndCharacteristics();

    const services = await this.device.services();
    this.log(`services: ${services.map((s) => s.uuid).join(', ') || '<none>'}`);

    const picked = await this.pickCharacteristics();
    if (!picked) {
      if (this.active) {
        this.emit({
          state: 'error',
          errorMsg:
            'Incompatible adapter. Found no BLE service with write+notify. ' +
            'Many cheap "Bluetooth" ELM327 clones are Bluetooth Classic (SPP) ' +
            'and cannot work on iOS. Check the log for details.',
        });
      }
      return;
    }

    this.serviceUuid = picked.serviceUuid;
    this.writeCharId = picked.writeUuid;
    this.writeWithResponse = picked.writeWithResponse;
    this.log(
      `using service=${picked.serviceUuid} write=${picked.writeUuid}` +
        `(${picked.writeWithResponse ? 'withResp' : 'noResp'}) notify=${picked.notifyUuid}`
    );

    this.device.monitorCharacteristicForService(
      picked.serviceUuid,
      picked.notifyUuid,
      (err: Error | null, char: Characteristic | null) => {
        if (err) {
          this.log(`notify error: ${err.message ?? err}`);
          return;
        }
        if (!char?.value) return;
        const chunk = Buffer.from(char.value, 'base64').toString('ascii');
        this.rxBuffer += chunk;
        // ELM327 terminates every response with the '>' prompt. Resolving on
        // '\r' alone truncates multi-line responses (e.g. "SEARCHING...\r41 00 ...\r>").
        if (this.rxBuffer.includes('>')) {
          const response = this.rxBuffer.replace(/>/g, '').trim();
          this.rxBuffer = '';
          this.responseResolve?.(response);
          this.responseResolve = null;
        }
      }
    );

    this.device.onDisconnected((err) => {
      this.log(`disconnected: ${err?.message ?? 'ok'}`);
      if (this.polling) this.scheduleReconnect();
    });

    for (const cmd of INIT_CMDS) {
      try {
        // ATZ is a chip reset; give it extra time and let the chip settle.
        await this.send(cmd, cmd === 'ATZ' ? 4000 : 2000);
        if (cmd === 'ATZ') await sleep(600);
      } catch {
        // non-fatal
      }
    }

    // Probe ECU. The first PID request triggers ELM327 auto-protocol search,
    // which can take 5–15s even with the ignition on. Retry once before giving up.
    const probeOk = await this.probeEcu();
    if (!probeOk) {
      if (this.active) this.emit({ state: 'error', errorMsg: 'ECU not responding. Turn ignition ON.' });
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

  private async pickCharacteristics(): Promise<{
    serviceUuid: string;
    writeUuid: string;
    notifyUuid: string;
    writeWithResponse: boolean;
  } | null> {
    if (!this.device) return null;
    const services = await this.device.services();

    // Rank services: known-good UUIDs first, then anything else.
    const ranked = [...services].sort((a, b) => {
      const ai = KNOWN_SERVICES.findIndex((u) => a.uuid.toLowerCase().startsWith(u.toLowerCase()));
      const bi = KNOWN_SERVICES.findIndex((u) => b.uuid.toLowerCase().startsWith(u.toLowerCase()));
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    for (const svc of ranked) {
      const chars = await svc.characteristics();
      const props = chars
        .map(
          (c) =>
            c.uuid.slice(0, 8) +
            (c.isWritableWithResponse ? 'W' : '') +
            (c.isWritableWithoutResponse ? 'w' : '') +
            (c.isNotifiable ? 'N' : '') +
            (c.isIndicatable ? 'I' : '')
        )
        .join(' ');
      this.log(`  svc ${svc.uuid} chars: ${props || '<none>'}`);

      const notify = chars.find((c) => c.isNotifiable || c.isIndicatable);
      if (!notify) continue;

      // Prefer a distinct write char if one exists, but on HM-10 the same char
      // handles both. Prefer write-with-response but accept w/o-response.
      const writeSameChar =
        notify.isWritableWithResponse || notify.isWritableWithoutResponse ? notify : null;
      const writeDifferent =
        chars.find(
          (c) => c.uuid !== notify.uuid && (c.isWritableWithResponse || c.isWritableWithoutResponse)
        ) || null;
      const write = writeDifferent ?? writeSameChar;
      if (!write) continue;

      return {
        serviceUuid: svc.uuid,
        writeUuid: write.uuid,
        notifyUuid: notify.uuid,
        writeWithResponse: !!write.isWritableWithResponse,
      };
    }
    return null;
  }

  private async probeEcu(): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.log(`probe 0100 attempt ${attempt + 1}`);
      try {
        const resp = await this.send('0100', 15000);
        if (isEcuUnreachable(resp)) {
          this.log(`probe: ECU unreachable ("${resp.slice(0, 60)}")`);
          continue;
        }
        // Accept both spaced ("41 00 ...") and compact ("4100...") responses.
        // ELM327 mode-01 positive response always starts with 41.
        if (/41\s*00/i.test(resp)) {
          this.log('probe: success');
          return true;
        }
        this.log(`probe: unrecognized response "${resp.slice(0, 80)}"`);
      } catch (e: any) {
        this.log(`probe: error ${e?.message ?? e}`);
      }
    }
    return false;
  }

  private async send(cmd: string, timeoutMs = 2000): Promise<string> {
    if (!this.device || !this.writeCharId || !this.serviceUuid) throw new Error('Not connected');

    this.rxBuffer = '';
    const bytes = Buffer.from(cmd + '\r').toString('base64');
    this.log(`> ${cmd}`);

    // Register the resolver BEFORE writing so a fast response is never dropped.
    let outerResolve!: (s: string) => void;
    let outerReject!: (e: Error) => void;
    const responsePromise = new Promise<string>((res, rej) => {
      outerResolve = res;
      outerReject = rej;
    });
    const t = setTimeout(() => {
      this.responseResolve = null;
      this.log(`timeout (${timeoutMs}ms) waiting for: ${cmd}`);
      outerReject(new Error('timeout'));
    }, timeoutMs);
    this.responseResolve = (resp) => {
      clearTimeout(t);
      this.log(`< ${resp.replace(/\s+/g, ' ').slice(0, 140)}`);
      outerResolve(resp);
    };

    try {
      await this.doWrite(bytes);
    } catch (e: any) {
      // Some adapters advertise both write modes but only one actually works.
      // Flip and retry once before surfacing the error.
      this.log(`write failed (${this.writeWithResponse ? 'withResp' : 'noResp'}): ${e?.message ?? e}; retrying other mode`);
      this.writeWithResponse = !this.writeWithResponse;
      try {
        await this.doWrite(bytes);
      } catch (e2: any) {
        clearTimeout(t);
        this.responseResolve = null;
        throw e2;
      }
    }

    return responsePromise;
  }

  private async doWrite(bytes: string) {
    if (this.writeWithResponse) {
      await this.device!.writeCharacteristicWithResponseForService(
        this.serviceUuid!,
        this.writeCharId!,
        bytes
      );
    } else {
      await this.device!.writeCharacteristicWithoutResponseForService(
        this.serviceUuid!,
        this.writeCharId!,
        bytes
      );
    }
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
      } catch (e: any) {
        // A BLE-level error (device disconnected, etc.) should trigger reconnect
        // immediately rather than waiting for the ATI keepalive checkpoint.
        // Plain PID timeouts are safe to skip.
        if (this.polling && !e?.message?.includes('timeout')) {
          this.log(`poll: BLE error, reconnecting — ${e.message}`);
          this.scheduleReconnect();
          return;
        }
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
      case '010C':
        if (bytes.length >= 2) this.data.rpm = ((A * 256) + B) / 4;
        break;
      case '010D':
        this.data.speedKmH = A;
        break;
      case '0110':
        if (bytes.length >= 2) this.data.mafGPerS = ((A * 256) + B) / 100;
        break;
      case '010B':
        this.data.mapKPa = A;
        break;
      case '010F':
        this.data.iatC = A - 40;
        break;
      case '0104':
        this.data.engineLoadPct = (A * 100) / 255;
        break;
      case '0105':
        this.data.coolantC = A - 40;
        break;
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

    this.data.fuelRateLPerH = null;
    this.data.fuelCalcMethod = 'none';
  }

  private scheduleReconnect() {
    if (!this.active) return;
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
    this.data = { ...this.data, ...patch, debugLog: [...this.logBuf] };
    this.onUpdate?.(this.data);
  }

  private emitCurrent() {
    this.onUpdate?.(this.data);
  }
}

function isEcuUnreachable(resp: string): boolean {
  const s = resp.toUpperCase();
  return (
    s.includes('UNABLE') ||
    s.includes('NO DATA') ||
    s.includes('BUS INIT') ||
    s.includes('CAN ERROR') ||
    s.includes('STOPPED') ||
    s.includes('BUFFER FULL') ||
    s.trim() === '?'
  );
}

function parseHexResponse(raw: string): number[] | null {
  // Strip transient ELM327 status lines so they don't get parsed as hex.
  const cleaned = raw
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^SEARCHING/i.test(l) && !/^BUS /i.test(l))
    .join(' ');
  const hexOnly = cleaned.replace(/[^0-9A-Fa-f\s]/g, '').trim();

  // Support both spaced format ("41 00 BE 3E") and compact format ("4100BE3E").
  let parts = hexOnly.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    const m = parts[0].match(/.{2}/g);
    if (m) parts = m;
  }
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
