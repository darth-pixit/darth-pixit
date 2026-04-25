/**
 * 4W Fleet Driver Safety Analytics Engine — types and configuration.
 *
 * ================================================================
 *  KEY DESIGN DIFFERENCES vs 2-WHEELER ENGINE
 * ================================================================
 *
 *  1. OBD-II IS THE PRIMARY SENSOR
 *  --------------------------------
 *  Cars have reliable OBD-II. Speed, RPM, engine load, coolant,
 *  throttle, and seatbelt (manufacturer PID) all come from OBD.
 *  GPS Kalman is the fallback when OBD is stale (> 500ms).
 *
 *  2. g-g CIRCLE CORNERING — NO LEAN ANGLE
 *  -----------------------------------------
 *  A car corners upright. The lateral g seen by the phone IS the
 *  centripetal acceleration. We use:
 *
 *    combined_g = sqrt(a_fwd² + a_lat²)
 *
 *  as the primary cornering scalar so simultaneous braking-in-corner
 *  (trail-braking) is penalised together. Thresholds:
 *    caution 0.35g, event 0.50g, severe 0.70g (vehicle-class adjusted).
 *
 *  3. LANE-CHANGE S-SHAPE DETECTION
 *  ----------------------------------
 *  A lane change produces a characteristic S-curve in lateral accel:
 *  the driver first pushes the car sideways, then corrects back. We
 *  detect the two-phase lateral profile in a 4-second sliding window.
 *
 *  4. ENGINE ABUSE MONITORING (OBD-DEPENDENT)
 *  -------------------------------------------
 *  Over-rev, lugging (manual gearbox), sustained high load, and
 *  coolant overheating are all scorable events — not just wear signals.
 *  They map to the 'engine_abuse' event type with subtype meta.
 *
 *  5. IDLING METRIC
 *  -----------------
 *  RPM > 600 AND speed = 0 for ≥ 60 s. Relevant for corporate fleet
 *  managers (fuel waste, emissions). Bucketed separately in scoring.
 *
 *  6. SEATBELT DETECTION
 *  ----------------------
 *  Requires manufacturer-specific OBD PID support, detected at pairing
 *  by OBDCapabilityDetector. When supported, seatbelt_off events fire
 *  after 5 s of moving above 5 km/h unbuckled.
 *
 *  7. DTC CODES
 *  -------------
 *  Mode 03 DTC read at trip start. Safety-critical DTCs (chassis codes
 *  C0xxx, brake-system codes) flag the trip as 'dtcSafetyCritical';
 *  such trips are excluded from comparative fleet ranking.
 *
 *  8. OBD CONNECTION LIFECYCLE
 *  ----------------------------
 *  DISCONNECTED → CONNECTING → CONNECTED → DEGRADED → RECONNECTING
 *  obd_uptime_pct is computed per trip. Trips below 50% are flagged
 *  OBD-degraded and excluded from cross-driver ranking.
 *
 *  9. SCORING WEIGHTS (spec §5.2)
 *  --------------------------------
 *    overspeed    0.22
 *    brake        0.20
 *    phone        0.18
 *    lane_change  0.10
 *    seatbelt     0.08
 *    cornering    0.08
 *    accel        0.07
 *    engine_abuse 0.04
 *    idling       0.03
 *    ─────────────────
 *    total        1.00
 */

import { SafetyConfig, DEFAULT_SAFETY_CONFIG } from '../types';

/** Cab hatchbacks, sedan fleets, SUVs, delivery vans, EVs, high-perf. */
export type CarClass =
  | 'hatchback'
  | 'sedan'
  | 'suv'
  | 'van'
  | 'ev_sedan'
  | 'ev_suv'
  | 'performance';

export type TransmissionType = 'automatic' | 'manual' | 'cvt' | 'ev';

/** OBD adapter connection state machine. */
export type OBDConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'reconnecting';

/** All scorable event types for 4W trips. */
export type CarSafetyEventType =
  | 'hard_acceleration'
  | 'hard_braking'
  | 'hard_cornering'
  | 'lane_change'
  | 'overspeeding'
  | 'phone_use'
  | 'seatbelt_off'
  | 'engine_abuse'
  | 'idling'
  | 'crash'
  | 'distracted_driving'
  | 'drowsy_driving';

export type EngineAbuseSubtype = 'over_rev' | 'lugging' | 'high_load' | 'overheating';

export interface CarSafetyEvent {
  id: string;
  type: CarSafetyEventType;
  startedAt: number;
  endedAt: number;
  /** Peak magnitude relevant to the event type (m/s², km/h, °C, etc.). */
  peak: number;
  severity: 1 | 2 | 3 | 4 | 5;
  location: { lat: number; lng: number } | null;
  meta?: Record<string, number | string | boolean>;
}

/**
 * OBD PID capability cache, written by OBDCapabilityDetector at first
 * pairing and keyed by vehicleId (VIN or user-assigned). Persisted so
 * probe doesn't repeat every session.
 */
export interface VehicleCapabilities {
  vehicleId: string;
  seatbeltPidSupported: boolean;
  /** PID 0111 (throttle position) — standard but not universal. */
  throttlePidSupported: boolean;
  /** Transmission gear PID (0xA4) — modern vehicles only. */
  gearPidSupported: boolean;
  probedAt: number;
}

/** Per-trip aggregate features for the 4W pipeline. */
export interface CarTripFeatures {
  /** Fraction [0,1] of trip duration with OBD connected and data flowing. */
  obdUptimePct: number;
  /** True when obdUptimePct < cfg.obdDegradedUptimeThreshold (default 0.50). */
  obdDegraded: boolean;
  /** True if a safety-critical DTC was active when the trip started. */
  dtcSafetyCritical: boolean;
  /** All DTC codes read at trip start (Mode 03). */
  dtcCodes: string[];
  idlingEvents: number;
  idlingTotalS: number;
  laneChangeCount: number;
  engineAbuseCount: number;
  peakSpeedKmH: number;
  seatbeltOffEvents: number;
  movingSeconds: number;
  phoneUsageRatio: number;
  peakRPM: number;
  /** Fraction of moving time with throttle at 0% (coasting). */
  coastRatio: number;
}

export interface CarConfig extends SafetyConfig {
  carClass: CarClass;
  transmission: TransmissionType;
  /**
   * VIN or fleet-assigned ID. Used as key for VehicleCapabilities cache
   * so PID probing only happens once per vehicle.
   */
  vehicleId: string;

  // ---- OBD ----

  /** OBD speed sample is considered fresh if < this many ms old. */
  obdFreshnessMs: number;           // default 500
  /** Trips with OBD uptime below this are flagged as OBD-degraded. */
  obdDegradedUptimeThreshold: number; // default 0.50

  // ---- GPS Kalman (fallback when OBD stale) ----

  gpsMaxAccuracyM: number;          // default 20
  gpsSettlingSeconds: number;       // default 5
  gpsKalmanProcessNoise: number;    // default 1.5

  // ---- g-g circle cornering ----

  /**
   * combined_g = sqrt(a_fwd² + a_lat²). Thresholds in m/s².
   * The g-g circle captures simultaneous braking-and-turning, which is
   * the most common loss-of-control scenario for cars on wet roads.
   */
  combinedGCautionMs2: number;      // 0.35g = 3.43
  combinedGEventMs2: number;        // 0.50g = 4.90
  combinedGSevereMs2: number;       // 0.70g = 6.87
  combinedGMinDurationS: number;    // default 0.4

  // ---- Hard acceleration ----

  accelCautionMs2: number;          // 0.30g = 2.94
  accelEventMs2: number;            // 0.35g = 3.43
  accelSevereMs2: number;           // 0.45g = 4.41
  accelMinDurationS: number;        // default 1.0

  // ---- Hard braking ----

  brakeCautionMs2: number;          // 0.32g = 3.14
  brakeEventMs2: number;            // 0.40g = 3.92
  brakeSevereMs2: number;           // 0.60g = 5.88
  brakeMinDurationS: number;        // default 0.5

  /** Normal-stop gate: gentle deceleration to zero is not flagged. */
  normalStopPeakMs2: number;        // default 3.14
  normalStopEndSpeedKmH: number;    // default 1.0

  // ---- ABS pulsing compaction ----

  /**
   * ABS modulates brake pressure at 5–15 Hz, producing rapid decel
   * oscillations. Without compaction, each oscillation could trigger a
   * separate hard-braking event. We detect the pulsing pattern and
   * collapse the entire ABS-braking episode into one compacted event.
   */
  absPulseMinFreqHz: number;        // default 5
  absPulseMaxFreqHz: number;        // default 15
  absPulseMinCycles: number;        // default 3

  // ---- Engine-braking false-positive filter ----

  /**
   * On a downhill with closed throttle, the engine generates sustained
   * forward deceleration that looks like hard braking. Suppress if:
   *   throttle ≈ 0% AND |a_fwd| < engineBrakeMaxDecelMs2 AND
   *   road grade > engineBrakeMinGradePct.
   */
  engineBrakeMaxDecelMs2: number;   // 0.25g = 2.45
  engineBrakeMinGradePct: number;   // default 3.0

  // ---- Lane change S-shape ----

  laneChangeWindowMs: number;       // default 4000
  laneChangePeakLatMs2: number;     // 0.20g = 1.96
  laneChangeMinDurationS: number;   // default 1.5
  laneChangeMaxDurationS: number;   // default 5.0
  laneChangeMaxHeadingChangeDeg: number; // default 15

  // ---- Overspeed ----

  absoluteSpeedLimitKmH: number;    // default 130
  overspeedBufferKmH: number;       // default 5
  minOverspeedDurationS: number;    // default 5

  // ---- Roundabout suppression ----

  /**
   * When OSM reports junction:roundabout for the current segment AND
   * combined_g is below this, suppress cornering events. Roundabout
   * manoeuvring is by definition controlled circling — it's not a risk.
   */
  roundaboutMaxCombinedGMs2: number; // 0.50g = 4.90

  // ---- Idling ----

  idleRPMMin: number;               // default 600
  idleSpeedMaxKmH: number;          // default 2
  idleMinDurationS: number;         // default 60

  // ---- Engine abuse ----

  /** RPM fraction of vehicleRedlineRPM above which over-rev fires. */
  overRevThresholdPct: number;      // default 0.95
  overRevMinDurationS: number;      // default 3
  /** Manual-only: RPM < this while throttle > luggingMinThrottlePct. */
  luggingMaxRPM: number;            // default 1200
  luggingMinThrottlePct: number;    // default 20
  /**
   * High sustained engine load above this speed threshold is NOT flagged
   * (highway cruise at WOT is normal). Below the threshold it signals
   * inefficient low-speed heavy-throttle use.
   */
  highLoadAboveSpeedKmH: number;    // default 70
  highLoadMinDurationS: number;     // default 20
  overheatCoolantC: number;         // default 105

  // ---- Seatbelt ----

  seatbeltMinSpeedKmH: number;      // default 5
  seatbeltMinDurationS: number;     // default 5

  // ---- DTC ----

  /**
   * DTC code PREFIXES that indicate a safety-critical fault. Any active
   * code starting with one of these strings causes the trip to be flagged
   * as dtcSafetyCritical and excluded from comparative ranking.
   *
   * Standard chassis codes: 'C' (e.g. C0031 = left front wheel speed).
   * Some brake system codes are 'B0' or 'U0'. Adjust per fleet OEM.
   */
  dtcSafetyCriticalPrefixes: string[]; // default ['C', 'B0', 'B1', 'U0']

  // ---- Phone use ----

  phoneUseMinSpeedKmH: number;      // default 10
  phoneUseMinDurationS: number;     // default 3
  phoneUseCallMinSpeedKmH: number;  // default 15
  phoneUseCallMinDurationS: number; // default 10
  phoneUseTouchesPerSec: number;    // default 1.5
  phonePositionMinConfidence: number; // default 0.7

  // ---- Time-of-day ----

  todDayWeight: number;             // default 1.0
  todDuskWeight: number;            // default 1.2
  todNightWeight: number;           // default 1.4

  // ---- Trip stitching ----

  /** Speed threshold below which the vehicle is considered paused. */
  tripIdleSpeedKmH: number;         // default 2
  /** Auto-end trip after this many continuous seconds below idle speed. */
  tripIdleEndSeconds: number;       // default 600 (10 min, vs 300 for 2W)
  /** Trips below this distance are flagged non-scorable. */
  tripMinDistanceM: number;         // default 1000 (1 km, vs 500 m for 2W)
  /** Trips below this duration are flagged non-scorable. */
  tripMinDurationS: number;         // default 180 (3 min, vs 2 min for 2W)

  // ---- Battery budget ----

  /**
   * Target active-sensor duration per charge. 12h for 4W (vs 8h for 2W)
   * because fleet vehicles often run full shifts. The engine uses this to
   * modulate GPS sampling rate when battery is low.
   */
  batteryBudgetHours: number;       // default 12

  // ---- Delivery/fleet app whitelist (mirrors 2W) ----

  deliveryAppIds: string[];         // default []

  // ---- Capability cache ----

  capabilities: VehicleCapabilities | null; // set by OBDCapabilityDetector
}

export const DEFAULT_CAR_CONFIG: CarConfig = {
  ...DEFAULT_SAFETY_CONFIG,

  carClass: 'sedan',
  transmission: 'automatic',
  vehicleId: '',

  obdFreshnessMs: 500,
  obdDegradedUptimeThreshold: 0.50,

  gpsMaxAccuracyM: 20,
  gpsSettlingSeconds: 5,
  gpsKalmanProcessNoise: 1.5,

  // g-g circle — sedan defaults
  combinedGCautionMs2: 3.43,   // 0.35g
  combinedGEventMs2:   4.90,   // 0.50g
  combinedGSevereMs2:  6.87,   // 0.70g
  combinedGMinDurationS: 0.4,

  accelCautionMs2: 2.94,       // 0.30g
  accelEventMs2:   3.43,       // 0.35g
  accelSevereMs2:  4.41,       // 0.45g
  accelMinDurationS: 1.0,

  brakeCautionMs2: 3.14,       // 0.32g
  brakeEventMs2:   3.92,       // 0.40g
  brakeSevereMs2:  5.88,       // 0.60g
  brakeMinDurationS: 0.5,

  normalStopPeakMs2: 3.14,
  normalStopEndSpeedKmH: 1.0,

  absPulseMinFreqHz: 5,
  absPulseMaxFreqHz: 15,
  absPulseMinCycles: 3,

  engineBrakeMaxDecelMs2: 2.45, // 0.25g
  engineBrakeMinGradePct: 3.0,

  laneChangeWindowMs: 4000,
  laneChangePeakLatMs2: 1.96,  // 0.20g
  laneChangeMinDurationS: 1.5,
  laneChangeMaxDurationS: 5.0,
  laneChangeMaxHeadingChangeDeg: 15,

  absoluteSpeedLimitKmH: 130,
  overspeedBufferKmH: 5,
  minOverspeedDurationS: 5,

  roundaboutMaxCombinedGMs2: 4.90, // 0.50g

  idleRPMMin: 600,
  idleSpeedMaxKmH: 2,
  idleMinDurationS: 60,

  overRevThresholdPct: 0.95,
  overRevMinDurationS: 3,
  luggingMaxRPM: 1200,
  luggingMinThrottlePct: 20,
  highLoadAboveSpeedKmH: 70,
  highLoadMinDurationS: 20,
  overheatCoolantC: 105,

  seatbeltMinSpeedKmH: 5,
  seatbeltMinDurationS: 5,

  dtcSafetyCriticalPrefixes: ['C', 'B0', 'B1', 'U0'],

  phoneUseMinSpeedKmH: 10,
  phoneUseMinDurationS: 3,
  phoneUseCallMinSpeedKmH: 15,
  phoneUseCallMinDurationS: 10,
  phoneUseTouchesPerSec: 1.5,
  phonePositionMinConfidence: 0.7,

  todDayWeight: 1.0,
  todDuskWeight: 1.2,
  todNightWeight: 1.4,

  tripIdleSpeedKmH: 2,
  tripIdleEndSeconds: 600,
  tripMinDistanceM: 1000,
  tripMinDurationS: 180,

  batteryBudgetHours: 12,

  deliveryAppIds: [],

  capabilities: null,
};

/** SUV: slightly higher combined-g threshold (more body roll is normal). */
export const DEFAULT_SUV_CONFIG: CarConfig = {
  ...DEFAULT_CAR_CONFIG,
  carClass: 'suv',
  combinedGEventMs2: 5.39,    // 0.55g
  combinedGSevereMs2: 7.36,   // 0.75g
  hardCornerThreshold: 5.39,  // matches combinedGEvent
};

/**
 * Van: lower g threshold — loaded vans tip earlier and have longer
 * stopping distances. Engine redline also lower than passenger cars.
 */
export const DEFAULT_VAN_CONFIG: CarConfig = {
  ...DEFAULT_CAR_CONFIG,
  carClass: 'van',
  combinedGCautionMs2: 2.94,  // 0.30g
  combinedGEventMs2:   4.41,  // 0.45g
  combinedGSevereMs2:  5.88,  // 0.60g
  brakeCautionMs2:     3.43,
  brakeEventMs2:       4.41,
  vehicleRedlineRPM:   4500,
  hardCornerThreshold: 4.41,
};

/**
 * EV sedan: raised acceleration thresholds — instant torque from zero
 * RPM means a clean 0→60 start that would register as hard_accel on
 * an ICE car is perfectly normal EV behaviour.
 */
export const DEFAULT_EV_SEDAN_CONFIG: CarConfig = {
  ...DEFAULT_CAR_CONFIG,
  carClass: 'ev_sedan',
  transmission: 'ev',
  accelCautionMs2: 3.92,      // 0.40g
  accelEventMs2:   4.90,      // 0.50g
  accelSevereMs2:  5.88,      // 0.60g
  // Over-rev / lugging are irrelevant for EVs; set to sentinel values.
  overRevThresholdPct: 1.0,
  luggingMaxRPM: 0,
};

export const DEFAULT_EV_SUV_CONFIG: CarConfig = {
  ...DEFAULT_EV_SEDAN_CONFIG,
  carClass: 'ev_suv',
  combinedGEventMs2: 5.39,
  combinedGSevereMs2: 7.36,
};

/**
 * Performance car: significantly raised thresholds. A sports car driven
 * enthusiastically on a B-road should not be penalised at the same
 * rate as a family sedan doing the same manoeuvre.
 */
export const DEFAULT_PERFORMANCE_CONFIG: CarConfig = {
  ...DEFAULT_CAR_CONFIG,
  carClass: 'performance',
  combinedGCautionMs2: 4.41,  // 0.45g
  combinedGEventMs2:   5.88,  // 0.60g
  combinedGSevereMs2:  7.85,  // 0.80g
  accelCautionMs2: 3.92,
  accelEventMs2:   4.90,
  accelSevereMs2:  6.87,
  vehicleRedlineRPM: 8000,
  hardCornerThreshold: 5.88,
};
