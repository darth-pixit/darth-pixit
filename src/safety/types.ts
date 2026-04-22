/**
 * Safety scoring types.
 *
 * Core model:
 *   SensorSample (raw) -> SensorFusion -> VehicleMotion
 *   GPSPoint (raw)     -> GPSTracker   -> distance, heading-rate, centripetal accel
 *   VehicleMotion + GPSSnapshot + OBD speed -> EventDetector -> SafetyEvent
 *   GyroscopeSample    -> DrowsinessDetector -> DrowsinessSignal
 *   OBDData stream     -> OBDWearMonitor     -> WearSignal
 *   GPS trail          -> RouteTracker       -> RouteContext
 *   GPS position       -> WeatherContext     -> WeatherSnapshot
 *   SafetyEvent[]      -> RecoveryTracker    -> recovered event IDs
 *   All of the above   -> SafetyScorer       -> SafetyScore
 */

export type Vec3 = { x: number; y: number; z: number };

// ---------- Sensor-layer (raw input) ----------

export interface AccelerometerSample {
  /** Raw phone-frame accel including gravity, m/s^2. */
  accel: Vec3;
  /** Monotonic timestamp, ms. Use performance.now() or Date.now(). */
  t: number;
}

export interface GyroscopeSample {
  /** Angular velocity rad/s in phone frame. */
  gyro: Vec3;
  t: number;
}

export interface GPSPoint {
  lat: number;
  lng: number;
  /** Speed in m/s. null means "unknown — use derived". */
  speedMPS: number | null;
  /** Heading in degrees clockwise from true north. null if unavailable. */
  headingDeg: number | null;
  /** Horizontal accuracy in meters (GPS HDOP proxy). */
  accuracyM: number;
  /** Altitude in meters (optional, used for road-grade correction). */
  altitudeM: number | null;
  t: number;
}

/** Snapshot of relevant OBD values at one polling cycle. */
export interface OBDSnapshot {
  rpm: number | null;
  speedKmH: number | null;
  engineLoadPct: number | null;
  coolantC: number | null;
  /** True if engine is at operating temperature (coolant > 70 C). */
  warmupComplete: boolean;
  t: number;
}

// ---------- Vehicle-frame motion (post fusion) ----------

export interface VehicleMotion {
  /**
   * Longitudinal acceleration (m/s^2). Positive = accelerating,
   * negative = decelerating (braking). Derived from speed derivative —
   * robust to phone orientation.
   */
  longitudinal: number;

  /**
   * Lateral acceleration (m/s^2). Positive = right turn, negative = left
   * turn. From centripetal formula v * dHeading/dt.
   */
  lateral: number;

  /**
   * Phone linear accel magnitude (m/s^2), gravity removed. Used as a
   * sanity check and as the primary signal for crash detection (since
   * GPS is too slow for impact physics).
   */
  linearMag: number;

  /** Speed source at this instant, m/s. */
  speedMPS: number;

  t: number;
}

// ---------- Safety events ----------

export type SafetyEventType =
  | 'hard_acceleration'
  | 'hard_braking'
  | 'hard_cornering'
  | 'overspeeding'
  | 'distracted_driving'
  | 'drowsy_driving'
  | 'crash';

export interface SafetyEvent {
  id: string;
  type: SafetyEventType;
  /** ms epoch. */
  startedAt: number;
  endedAt: number;
  /**
   * Peak magnitude of the primary signal. For acceleration-like events
   * that's m/s^2; for overspeeding it's max excess speed in km/h;
   * for distracted/drowsy it's the duration in seconds.
   */
  peak: number;
  /** 1 (borderline) … 5 (extreme). */
  severity: 1 | 2 | 3 | 4 | 5;
  /** Location at the peak, if known. */
  location: { lat: number; lng: number } | null;
  /** Extra per-type context (speed at peak, speed limit, etc.). */
  meta?: Record<string, number | string | boolean>;
}

// ---------- Vehicle wear signals ----------

export type WearSignalType =
  | 'sustained_high_load'   // engine load > 80% for > 30s
  | 'coolant_spike'         // coolant > configurable max (default 105 C)
  | 'high_rpm_ratio'        // RPM > 85% of redline for > 10s
  | 'seatbelt_off'          // OBD seatbelt PID says unfastened (when available)
  | 'tpms_low';             // TPMS reports low pressure (when available)

export interface WearSignal {
  type: WearSignalType;
  /** The measured value (%, RPM, °C, etc.). */
  value: number;
  /** The threshold that was exceeded. */
  threshold: number;
  detectedAt: number;
  /** How many continuous seconds the condition was sustained. */
  durationS: number;
  severity: 1 | 2 | 3 | 4 | 5;
  location: { lat: number; lng: number } | null;
}

// ---------- Weather ----------

export type WeatherCondition =
  | 'clear'
  | 'overcast'
  | 'fog'
  | 'light_rain'
  | 'heavy_rain'
  | 'snow'
  | 'thunderstorm';

export interface WeatherSnapshot {
  fetchedAt: number;
  location: { lat: number; lng: number };
  condition: WeatherCondition;
  precipitationMmH: number;
  /** Raw WMO weather code from Open-Meteo (preserved for debugging). */
  weatherCode: number;
  /**
   * Multiplier applied to hard-cornering and hard-braking detection
   * thresholds. Values < 1 lower the threshold (makes detection more
   * sensitive in bad weather — appropriate because the same manoeuvre
   * is more dangerous on wet/icy roads).
   *
   * Clear = 1.0, light rain = 0.90, heavy rain = 0.82, snow = 0.70.
   *
   * WHY threshold-scaling instead of penalty-scaling:
   *   We want the driver to *actually be detected* doing a dangerous
   *   thing in rain, not just penalized more for the same event count.
   *   Lowering the threshold makes the detection accurately reflect
   *   the real risk of a given manoeuvre under reduced grip.
   *
   *   Trade-off: drivers who always drive in rain will show higher
   *   event counts. Mitigation: per-trip weather context is stored so
   *   comparisons can be filtered by condition.
   */
  thresholdFactor: number;
  source: 'api' | 'gps_accuracy' | 'manual';
}

// ---------- Route context ----------

export interface RouteContext {
  /**
   * 0.0 = first time on this exact route, 1.0 = driven many times.
   * Computed by matching the trip's GPS tiles against a visited-tile
   * store.
   */
  familiarityScore: number;
  /**
   * Penalty multiplier from [0.85, 1.0].
   *   1.0  = all tiles known (no grace)
   *   0.85 = route is entirely new (15% penalty reduction)
   *
   * Rationale: on an unfamiliar road you might brake harder because you
   * don't know a sharp bend is coming, or speed slightly because you
   * don't know the posted limit. The grace is small and vanishes after
   * a few repetitions of the same route.
   */
  graceFactor: number;
  tilesMatched: number;
  tilesTotal: number;
}

// ---------- Drowsiness ----------

export interface DrowsinessSignal {
  detectedAt: number;
  /**
   * Ratio of current 60s yaw-rate variance vs. the calibrated baseline
   * from the first 5 minutes of highway driving this trip.
   * Rule of thumb: ratio >= 2.0 → possible drowsiness.
   */
  varianceRatio: number;
  /** Speed at detection, km/h. */
  speedKmH: number;
  /** How long high variance has been sustained, ms. */
  durationMs: number;
}

// ---------- Crash report ----------

export interface CrashReport {
  id: string;
  detectedAt: number;
  location: { lat: number; lng: number } | null;
  /** Peak linear-accel magnitude, m/s^2. */
  peakG: number;
  /** Speed (km/h) at impact, from OBD or GPS (whichever was freshest). */
  speedAtImpactKmH: number | null;
  /**
   * Downsampled pre-impact accelerometer trace (last ~10s at ~20Hz ≈
   * 200 samples) for post-mortem review.
   */
  preImpactTrace: Array<{ t: number; mag: number }>;
  postImpactTrace: Array<{ t: number; mag: number }>;
  preImpactTrail: GPSPoint[];
  confirmedStop: boolean;
  featuresTriggered: number;
}

// ---------- Scoring ----------

export interface CategoryScore {
  /** 0..100, 100 = perfect. */
  score: number;
  penalty: number;
  eventCount: number;
  /** How many of those events had the recovery bonus applied. */
  recoveredCount: number;
}

export interface SafetyScore {
  composite: number;
  acceleration: CategoryScore;
  braking: CategoryScore;
  cornering: CategoryScore;
  speeding: CategoryScore;
  distracted: CategoryScore;
  crashed: boolean;
  /** Reflects the route grace factor applied (1.0 = no grace). */
  routeGraceFactor: number;
  /** Weather snapshot active during trip, if available. */
  weatherCondition: WeatherCondition | null;
}

// ---------- Trip ----------

export type TripStatus = 'idle' | 'active' | 'ended';

export interface TripRecord {
  id: string;
  startedAt: number;
  endedAt: number | null;
  distanceM: number;
  activeDurationMs: number;
  events: SafetyEvent[];
  trail: Array<{ lat: number; lng: number; t: number }>;
  score: SafetyScore | null;
  crash: CrashReport | null;
  /** Vehicle wear signals raised during the trip. */
  wearSignals: WearSignal[];
  drowsinessEvents: DrowsinessSignal[];
  weatherContext: WeatherSnapshot | null;
  routeContext: RouteContext | null;
}

// ---------- Configuration ----------

export interface SafetyConfig {
  hardAccelThreshold: number;       // m/s^2, default 3.0
  hardBrakeThreshold: number;       // m/s^2, default 3.2
  hardCornerThreshold: number;      // m/s^2, default 4.2
  minEventDurationS: number;        // s, default 0.6
  maxEventGapS: number;             // s, default 3.0

  absoluteSpeedLimitKmH: number;    // default 130
  zoneSpeedLimitKmH: number | null; // null = no zone limit
  overspeedBufferKmH: number;       // default 5
  minOverspeedDurationS: number;    // default 3

  distractedMinSpeedKmH: number;    // default 10
  distractedMinDurationS: number;   // default 3

  crashPeakThreshold: number;       // m/s^2, default 24.5 (~2.5g)
  crashMinSpeedKmH: number;         // default 15
  crashSpeedDropKmH: number;        // default 15

  minScorableDistanceM: number;     // default 1000

  // --- Vehicle wear ---
  /** RPM at which engine redlines. Used for RPM-ratio wear signal. */
  vehicleRedlineRPM: number;        // default 6500
  /** Engine load % above which "sustained high load" is flagged. */
  highLoadThresholdPct: number;     // default 80
  /** Seconds of sustained high load before a WearSignal fires. */
  highLoadMinDurationS: number;     // default 30
  /** Coolant temperature (°C) at which a spike warning fires. */
  maxCoolantTempC: number;          // default 105

  // --- Weather ---
  /**
   * Whether to fetch weather from Open-Meteo at trip start.
   * Disable if you want fully offline operation with no network calls.
   * Fallback: GPS accuracy heuristic still runs regardless.
   */
  enableWeatherAPI: boolean;        // default true
  /**
   * Minimum km/h for weather to affect detection thresholds.
   * Below this speed threshold-scaling has no meaningful safety impact.
   */
  weatherThresholdMinSpeedKmH: number; // default 30

  // --- Route familiarity ---
  /**
   * Tile side length in degrees (~0.005° ≈ 500m at mid-latitudes).
   * Smaller = more precise, more storage; larger = coarser, less storage.
   */
  routeTileSize: number;            // default 0.005
  /** Visits per tile to consider a route "fully familiar". */
  routeFullFamiliarVisits: number;  // default 5

  // --- Recovery ---
  /** Minutes of clean driving after an event to earn the recovery bonus. */
  recoveryWindowMinutes: number;    // default 10
  /** Fraction of the original penalty retained when recovered. 0.8 = 20% bonus. */
  recoveryPenaltyFactor: number;    // default 0.8

  // --- Drowsiness ---
  /**
   * Speed (km/h) above which drowsiness detection runs. Below this we
   * can't reliably distinguish micro-corrections from normal manoeuvres.
   */
  drowsyMinSpeedKmH: number;        // default 80
  /**
   * Minimum minutes of above-threshold-speed driving before calibration
   * completes and drowsiness detection activates.
   */
  drowsyCalibrationMinutes: number; // default 5
  /**
   * Variance ratio (current / baseline) that triggers a drowsy alert.
   * Threshold of 2.0 is conservatively high to avoid false alarms.
   */
  drowsyVarianceRatioThreshold: number; // default 2.0
  /**
   * Seconds of elevated variance before a drowsy event fires.
   * Prevents transient spikes (roundabout, slalom) from triggering.
   */
  drowsyMinElevatedDurationS: number;   // default 30
}

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  hardAccelThreshold: 3.0,
  hardBrakeThreshold: 3.2,
  hardCornerThreshold: 4.2,
  minEventDurationS: 0.6,
  maxEventGapS: 3.0,

  absoluteSpeedLimitKmH: 130,
  zoneSpeedLimitKmH: null,
  overspeedBufferKmH: 5,
  minOverspeedDurationS: 3,

  distractedMinSpeedKmH: 10,
  distractedMinDurationS: 3,

  crashPeakThreshold: 24.5,
  crashMinSpeedKmH: 15,
  crashSpeedDropKmH: 15,

  minScorableDistanceM: 1000,

  vehicleRedlineRPM: 6500,
  highLoadThresholdPct: 80,
  highLoadMinDurationS: 30,
  maxCoolantTempC: 105,

  enableWeatherAPI: true,
  weatherThresholdMinSpeedKmH: 30,

  routeTileSize: 0.005,
  routeFullFamiliarVisits: 5,

  recoveryWindowMinutes: 10,
  recoveryPenaltyFactor: 0.8,

  drowsyMinSpeedKmH: 80,
  drowsyCalibrationMinutes: 5,
  drowsyVarianceRatioThreshold: 2.0,
  drowsyMinElevatedDurationS: 30,
};
