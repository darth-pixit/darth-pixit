/**
 * Safety scoring types.
 *
 * Core model:
 *   SensorSample (raw) -> SensorFusion -> VehicleMotion
 *   GPSPoint (raw)     -> GPSTracker   -> distance, heading-rate, centripetal accel
 *   VehicleMotion + GPSSnapshot + OBD speed -> EventDetector -> SafetyEvent
 *   SafetyEvent[] + trip distance -> SafetyScorer -> SafetyScore
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
  /** Speed in m/s. Negative/NaN means "unknown — use derived". */
  speedMPS: number | null;
  /** Heading in degrees clockwise from true north. null if unavailable. */
  headingDeg: number | null;
  /** Horizontal accuracy in meters (GPS HDOP proxy). */
  accuracyM: number;
  /** Altitude in meters (optional, used for road-grade correction). */
  altitudeM: number | null;
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
   * for distracted_driving it's the duration in seconds used to compute
   * severity.
   */
  peak: number;
  /** 1 (borderline) … 5 (extreme). */
  severity: 1 | 2 | 3 | 4 | 5;
  /** Location at the peak, if known. */
  location: { lat: number; lng: number } | null;
  /** Extra per-type context (speed at peak, speed limit, etc.). */
  meta?: Record<string, number | string | boolean>;
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
   * Downsampled pre-impact accelerometer trace (last ~10s at ~20Hz ~=
   * 200 samples) for post-mortem review. We downsample from the 60Hz
   * ring buffer to keep the report small enough to store/transmit.
   */
  preImpactTrace: Array<{ t: number; mag: number }>;
  /** Post-impact trace — same format, first ~10s after detection. */
  postImpactTrace: Array<{ t: number; mag: number }>;
  /** Snapshot of last N GPS points before impact. */
  preImpactTrail: GPSPoint[];
  /** True if speed settled near 0 after impact (confirms a real stop). */
  confirmedStop: boolean;
  /** Number of independent crash-like features that fired — see CrashReporter. */
  featuresTriggered: number;
}

// ---------- Scoring ----------

export interface CategoryScore {
  /** 0..100, 100 = perfect. */
  score: number;
  /** Sum of penalty points contributed by this category on this trip. */
  penalty: number;
  /** How many events in this category. */
  eventCount: number;
}

export interface SafetyScore {
  /** Weighted composite 0..100. */
  composite: number;
  acceleration: CategoryScore;
  braking: CategoryScore;
  cornering: CategoryScore;
  speeding: CategoryScore;
  distracted: CategoryScore;
  /** True if a crash was detected — floors the composite. */
  crashed: boolean;
}

// ---------- Trip ----------

export type TripStatus = 'idle' | 'active' | 'ended';

export interface TripRecord {
  id: string;
  startedAt: number;
  endedAt: number | null;
  distanceM: number;
  /** ms driven with speed > 0. Total elapsed - idle = active time. */
  activeDurationMs: number;
  events: SafetyEvent[];
  /** Downsampled breadcrumb for display — NOT every GPS sample. */
  trail: Array<{ lat: number; lng: number; t: number }>;
  score: SafetyScore | null;
  crash: CrashReport | null;
}

// ---------- Configuration ----------

export interface SafetyConfig {
  /** m/s^2. Default 3.0 — see EventDetector for rationale. */
  hardAccelThreshold: number;
  /** m/s^2. Default 3.2 — asymmetric with accel because humans brake harder than they accel. */
  hardBrakeThreshold: number;
  /** m/s^2. Default 4.2 lateral — ~0.43g, well above comfortable cornering. */
  hardCornerThreshold: number;
  /** Minimum continuous duration for a hard event to register (s). */
  minEventDurationS: number;
  /** Gap (s) under which two events of the same type merge into one. */
  maxEventGapS: number;

  /** km/h. Any speed above this is always flagged regardless of context. */
  absoluteSpeedLimitKmH: number;
  /** km/h. User-configurable "current zone" speed limit. null = no zone limit applied. */
  zoneSpeedLimitKmH: number | null;
  /** km/h buffer before overspeeding triggers (e.g., 5 = grace above limit). */
  overspeedBufferKmH: number;
  /** Minimum duration of sustained overspeed before an event fires (s). */
  minOverspeedDurationS: number;

  /** km/h. Below this speed we don't attribute distraction — you're probably stopped / parking. */
  distractedMinSpeedKmH: number;
  /** s. Minimum duration in background while moving to count as distraction. */
  distractedMinDurationS: number;

  /** m/s^2. Primary crash trigger — 2.5g ≈ 24.5 m/s^2. */
  crashPeakThreshold: number;
  /** km/h. Below this at impact we ignore — likely phone drop, not a wreck. */
  crashMinSpeedKmH: number;
  /** km/h. Required speed drop within 5s post-impact to confirm a crash. */
  crashSpeedDropKmH: number;

  /** Minimum distance before a trip is considered scorable. */
  minScorableDistanceM: number;
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
};
