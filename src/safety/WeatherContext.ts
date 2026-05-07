/**
 * WeatherContext — fetches current weather and derives threshold
 * scaling factors for the safety detectors.
 *
 * =============================================================
 *  Why Open-Meteo specifically?
 * =============================================================
 *
 *  - Free with no rate limits for reasonable usage, no API key.
 *  - Open source server code: https://github.com/open-meteo/open-meteo
 *  - Returns precipitation rate (mm/h) and WMO weather codes which
 *    directly encode road-safety-relevant conditions.
 *  - GDPR-friendly: no user account, no tracking.
 *  - Fallback when offline: GPS accuracy heuristic still applies.
 *
 * =============================================================
 *  Threshold scaling rationale
 * =============================================================
 *
 *  NHTSA studies show wet roads increase stopping distances by 20–40%.
 *  Snow/ice can increase them by 300–700%. The cornering limit drops
 *  proportionally because lateral grip ≈ longitudinal grip.
 *
 *  We model this as a thresholdFactor applied to hard-corner and
 *  hard-brake detection:
 *
 *    effective_threshold = base_threshold × thresholdFactor
 *
 *  Lower factor = more sensitive detection = more events flagged in
 *  bad weather = correct, because the same manoeuvre is more dangerous.
 *
 *  WHY we don't lower the hard-accel threshold in rain:
 *    Acceleration rarely causes loss-of-control at the g-levels we flag
 *    (0.3g) on wet roads. It does on ice, but we'd need traction-control
 *    wheel-speed data to detect that precisely. Keeping accel threshold
 *    constant avoids false positives on wet-road standing starts.
 *
 *  CRITIQUE: This approach penalises drivers who genuinely need to drive
 *  in rain more than those who only drive in sun, even if both drive
 *  identically. Mitigation: weatherCondition is stored per trip so the
 *  UI can offer "all conditions" vs "dry only" score comparisons.
 *
 * =============================================================
 *  WMO code → condition → threshold factor
 * =============================================================
 *  0–3, 4–9:   clear / overcast  → 1.00
 *  45–48:      fog               → 0.92  (visibility, not grip)
 *  51–55:      light_rain        → 0.88  (drizzle)
 *  56–57:      heavy_rain        → 0.80  (freezing drizzle)
 *  61–65:      light_rain        → 0.88  (moderate rain)
 *  66–67:      heavy_rain        → 0.80  (freezing rain)
 *  71–77:      snow              → 0.70
 *  80–82:      light_rain        → 0.88  (showers)
 *  85–86:      snow              → 0.70  (snow showers)
 *  95–99:      thunderstorm      → 0.80
 */

import {
  WeatherSnapshot,
  WeatherCondition,
  SafetyConfig,
  DEFAULT_SAFETY_CONFIG,
} from './types';

const OPEN_METEO_URL =
  'https://api.open-meteo.com/v1/forecast' +
  '?current=precipitation,weather_code' +
  '&forecast_days=1';

/** Cache TTL: re-fetch only if the last fetch was > 30 min ago. */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** Fallback: if GPS horizontal accuracy is degraded in urban area, assume wet. */
const POOR_GPS_ACCURACY_M = 25;

export class WeatherContext {
  private cfg: SafetyConfig;
  private cache: WeatherSnapshot | null = null;

  constructor(cfg: SafetyConfig = DEFAULT_SAFETY_CONFIG) {
    this.cfg = cfg;
  }

  updateConfig(patch: Partial<SafetyConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  /**
   * Returns a WeatherSnapshot for the given location. Tries:
   *   1. In-memory cache (if still fresh).
   *   2. Open-Meteo API (if enableWeatherAPI = true and network available).
   *   3. GPS accuracy heuristic.
   *
   * Never throws — weather is advisory only. Returns null if all paths fail.
   */
  async fetch(
    lat: number,
    lng: number,
    currentGPSAccuracyM?: number,
  ): Promise<WeatherSnapshot | null> {
    const now = Date.now();

    // Cache hit
    if (this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache;
    }

    // API fetch
    if (this.cfg.enableWeatherAPI) {
      const snap = await this.fetchFromAPI(lat, lng, now);
      if (snap) {
        this.cache = snap;
        return snap;
      }
    }

    // GPS accuracy fallback
    if (currentGPSAccuracyM !== undefined && currentGPSAccuracyM > POOR_GPS_ACCURACY_M) {
      const snap = this.makeGPSFallback(lat, lng, now);
      // Don't cache the fallback long — next real fetch should overwrite.
      this.cache = { ...snap, fetchedAt: now - CACHE_TTL_MS + 60_000 };
      return snap;
    }

    return null;
  }

  /** Invalidate cache (e.g., when GPS location changes significantly). */
  invalidate(): void {
    this.cache = null;
  }

  getCached(): WeatherSnapshot | null {
    return this.cache;
  }

  private async fetchFromAPI(lat: number, lng: number, now: number): Promise<WeatherSnapshot | null> {
    const url = `${OPEN_METEO_URL}&latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return null;
      const json = await resp.json() as {
        current?: { precipitation?: number; weather_code?: number };
      };
      const current = json?.current;
      if (!current) return null;

      const precipMmH = current.precipitation ?? 0;
      const code = current.weather_code ?? 0;
      const condition = wmoCodeToCondition(code);
      const thresholdFactor = conditionToThresholdFactor(condition);

      return {
        fetchedAt: now,
        location: { lat, lng },
        condition,
        precipitationMmH: precipMmH,
        weatherCode: code,
        thresholdFactor,
        source: 'api',
      };
    } catch {
      return null;
    }
  }

  private makeGPSFallback(lat: number, lng: number, now: number): WeatherSnapshot {
    // Poor GPS accuracy in an urban area often correlates with rain (signal
    // multipath is worse in rain). This is a very weak signal — we only use it
    // to apply a small threshold reduction (light_rain level).
    return {
      fetchedAt: now,
      location: { lat, lng },
      condition: 'light_rain',
      precipitationMmH: 0,
      weatherCode: -1,
      thresholdFactor: 0.90,
      source: 'gps_accuracy',
    };
  }
}

function wmoCodeToCondition(code: number): WeatherCondition {
  if (code === 0 || (code >= 1 && code <= 3)) return 'clear';
  if (code >= 45 && code <= 48) return 'fog';
  if (code >= 51 && code <= 55) return 'light_rain';
  if (code >= 56 && code <= 57) return 'heavy_rain'; // freezing drizzle → treat as heavy
  if (code >= 61 && code <= 65) return 'light_rain';
  if (code >= 66 && code <= 67) return 'heavy_rain'; // freezing rain
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'light_rain';  // showers
  if (code >= 85 && code <= 86) return 'snow';        // snow showers
  if (code >= 95 && code <= 99) return 'thunderstorm';
  if (code >= 4 && code <= 9)   return 'overcast';
  return 'clear';
}

export function conditionToThresholdFactor(condition: WeatherCondition): number {
  switch (condition) {
    case 'clear':        return 1.00;
    case 'overcast':     return 1.00;
    case 'fog':          return 0.92;
    case 'light_rain':   return 0.88;
    case 'heavy_rain':   return 0.80;
    case 'snow':         return 0.70;
    case 'thunderstorm': return 0.80;
  }
}
