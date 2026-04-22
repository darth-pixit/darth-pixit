/**
 * OBDWearMonitor — detects vehicle stress/wear conditions from the
 * existing OBD data stream and fires WearSignal events.
 *
 * =============================================================
 *  Three signals, all derived from data the OBD adapter already sends
 * =============================================================
 *
 * 1. Sustained high engine load (> 80% for > 30 s)
 *    Why 80%: at full load an engine generates peak heat, peak wear on
 *    piston rings and valve seals, and peak fuel consumption. Sustained
 *    is the key word — an 80% load for 0.5 s (overtaking) is normal;
 *    80% load for 60 s means driving at near-WOT continuously.
 *    CRITIQUE: on a motorway hill climb, 80% load is expected and not
 *    a wear concern. We don't have grade data, so we can't distinguish
 *    hill-climbing from aggressive freeway driving. A future fix is to
 *    use GPS altitude derivative to discount sustained load on steep
 *    inclines.
 *
 * 2. Coolant spike (> 105 °C)
 *    Why 105 °C: most water-cooled engines run at 90–100 °C; 105 °C is
 *    the onset of the "warning zone" for most cars. Sustained above
 *    this risks head-gasket failure. One reading is enough to alert —
 *    we don't need a duration here.
 *    CRITIQUE: the OBD coolant reading can lag the true coolant temp by
 *    several seconds (OBD polling, sensor location). A spike to 106 °C
 *    for one reading might be noise. We require two consecutive readings
 *    above threshold to filter single-sample noise.
 *
 * 3. RPM-to-redline ratio (> 85% of configured redline for > 10 s)
 *    Why 85%: variable-valve-timing engines often generate peak torque
 *    at 70–80% of redline, but sustained running above ~85% stresses the
 *    valvetrain beyond its long-term design point. We need the driver to
 *    configure their redline (default 6500 rpm covers most modern
 *    4-cylinder petrol cars). This is why vehicleRedlineRPM is in config.
 *    CRITIQUE: electric vehicles have no redline; diesel engines have
 *    a much lower redline (~4000 rpm). If the user hasn't configured
 *    the correct value this signal will either over-fire or miss. We
 *    mitigate by defaulting to 6500 and showing the config prominently.
 *
 * Seatbelt and TPMS signals are raised by the OBD extended-PID layer
 * (src/obd/OBDManager.ts) and forwarded here.
 */

import { WearSignal, WearSignalType, SafetyConfig, DEFAULT_SAFETY_CONFIG } from './types';

export type WearSignalListener = (signal: WearSignal) => void;

interface LoadState {
  aboveThresholdSince: number | null;
  latestT: number;
}

export class OBDWearMonitor {
  private cfg: SafetyConfig;
  private listener: WearSignalListener | null = null;

  private loadState: LoadState = { aboveThresholdSince: null, latestT: 0 };
  private coolantConsecutiveCount = 0;

  /** How many consecutive RPM readings above ratio threshold. */
  private rpmAboveCount = 0;
  private rpmAboveSince = 0;

  private locationGetter: () => { lat: number; lng: number } | null;

  constructor(
    locationGetter: () => { lat: number; lng: number } | null,
    cfg: SafetyConfig = DEFAULT_SAFETY_CONFIG,
  ) {
    this.locationGetter = locationGetter;
    this.cfg = cfg;
  }

  setListener(l: WearSignalListener): void {
    this.listener = l;
  }

  updateConfig(patch: Partial<SafetyConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  /**
   * Call every time a new OBD polling cycle completes.
   * rpm, engineLoadPct, and coolantC may be null if that PID hasn't
   * been read yet in this cycle.
   */
  ingest(params: {
    rpm: number | null;
    engineLoadPct: number | null;
    coolantC: number | null;
    t: number;
  }): void {
    const { rpm, engineLoadPct, coolantC, t } = params;

    if (engineLoadPct !== null) this.checkEngineLoad(engineLoadPct, t);
    if (coolantC !== null) this.checkCoolant(coolantC, t);
    if (rpm !== null) this.checkRPM(rpm, t);
  }

  /**
   * Forward seatbelt or TPMS signals raised by the OBD layer.
   * OBDManager calls this when it has a confirmed result from the
   * extended PID polling.
   */
  forwardExternalSignal(type: WearSignalType, value: number, threshold: number, t: number): void {
    this.emit({
      type,
      value,
      threshold,
      detectedAt: t,
      durationS: 0,
      severity: 2,
      location: this.locationGetter(),
    });
  }

  reset(): void {
    this.loadState = { aboveThresholdSince: null, latestT: 0 };
    this.coolantConsecutiveCount = 0;
    this.rpmAboveCount = 0;
    this.rpmAboveSince = 0;
  }

  private checkEngineLoad(loadPct: number, t: number): void {
    const threshold = this.cfg.highLoadThresholdPct;
    if (loadPct >= threshold) {
      if (this.loadState.aboveThresholdSince === null) {
        this.loadState.aboveThresholdSince = t;
      }
      this.loadState.latestT = t;
      const durationS = (t - this.loadState.aboveThresholdSince) / 1000;
      if (durationS >= this.cfg.highLoadMinDurationS) {
        // Fire once per 30s to avoid spamming while condition persists.
        const fireInterval = this.cfg.highLoadMinDurationS * 1000;
        const shouldFire =
          durationS >= this.cfg.highLoadMinDurationS &&
          (t - this.loadState.aboveThresholdSince) % fireInterval < 1500;
        if (shouldFire) {
          this.emit({
            type: 'sustained_high_load',
            value: loadPct,
            threshold,
            detectedAt: t,
            durationS,
            severity: this.loadSeverity(loadPct),
            location: this.locationGetter(),
          });
        }
      }
    } else {
      this.loadState.aboveThresholdSince = null;
    }
  }

  private checkCoolant(tempC: number, t: number): void {
    const threshold = this.cfg.maxCoolantTempC;
    if (tempC >= threshold) {
      this.coolantConsecutiveCount++;
      // Require 2 consecutive readings to filter sensor noise.
      if (this.coolantConsecutiveCount >= 2) {
        const excess = tempC - threshold;
        this.emit({
          type: 'coolant_spike',
          value: tempC,
          threshold,
          detectedAt: t,
          durationS: this.coolantConsecutiveCount * 2, // low-priority PID updates every ~2s
          severity: excess < 3 ? 2 : excess < 8 ? 3 : excess < 15 ? 4 : 5,
          location: this.locationGetter(),
        });
        // Reset to prevent re-firing every reading while hot.
        this.coolantConsecutiveCount = -8; // block for ~16s (8 readings × 2s)
      }
    } else {
      if (this.coolantConsecutiveCount < 0) this.coolantConsecutiveCount++;
      else this.coolantConsecutiveCount = 0;
    }
  }

  private checkRPM(rpm: number, t: number): void {
    const ratio = rpm / this.cfg.vehicleRedlineRPM;
    const threshold = 0.85;
    if (ratio >= threshold) {
      if (this.rpmAboveSince === 0) this.rpmAboveSince = t;
      this.rpmAboveCount++;
      const durationS = (t - this.rpmAboveSince) / 1000;
      // Require 10 s sustained. OBD RPM comes at ~4 Hz so ~40 readings.
      if (durationS >= 10 && this.rpmAboveCount % 40 === 0) {
        this.emit({
          type: 'high_rpm_ratio',
          value: Math.round(rpm),
          threshold: Math.round(this.cfg.vehicleRedlineRPM * threshold),
          detectedAt: t,
          durationS,
          severity: ratio >= 0.95 ? 4 : ratio >= 0.90 ? 3 : 2,
          location: this.locationGetter(),
        });
      }
    } else {
      this.rpmAboveCount = 0;
      this.rpmAboveSince = 0;
    }
  }

  private loadSeverity(pct: number): 1 | 2 | 3 | 4 | 5 {
    if (pct < 85) return 2;
    if (pct < 90) return 3;
    if (pct < 95) return 4;
    return 5;
  }

  private emit(signal: WearSignal): void {
    this.listener?.(signal);
  }
}
