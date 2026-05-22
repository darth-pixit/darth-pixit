import React, { useMemo } from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  SafeAreaView,
} from 'react-native';
import { useOBDStore } from '../obd/OBDStore';
import { OBDData, SeatbeltStatus } from '../obd/OBDManager';

interface VitalsScreenProps {
  visible: boolean;
  onClose: () => void;
}

type Severity = 'good' | 'warn' | 'bad' | 'neutral';

interface VitalRow {
  label: string;
  /** Pre-formatted value (e.g. "92", "12.4"). null = unsupported / not yet read. */
  value: string | null;
  unit?: string;
  /** Color hint for the value. Falls back to 'neutral' (white). */
  severity?: Severity;
  /** One-line description of why this matters. */
  hint?: string;
}

interface VitalSection {
  title: string;
  subtitle: string;
  rows: VitalRow[];
}

const SEVERITY_COLORS: Record<Severity, string> = {
  good: '#22C55E',
  warn: '#F59E0B',
  bad: '#EF4444',
  neutral: '#FFFFFF',
};

/** Format a number with N decimals, returning null for null/NaN. */
function fmt(n: number | null | undefined, decimals = 0): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return n.toFixed(decimals);
}

/** Convert seconds to "Hh Mm Ss" / "Mm Ss" / "Ss". */
function fmtDuration(totalSec: number | null): string | null {
  if (totalSec == null || !Number.isFinite(totalSec)) return null;
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Convert minutes to "Hh Mm". */
function fmtMinutes(totalMin: number | null): string | null {
  if (totalMin == null || !Number.isFinite(totalMin)) return null;
  const m = Math.max(0, Math.floor(totalMin));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

function kpaToPsi(kpa: number | null): number | null {
  if (kpa == null) return null;
  return kpa * 0.145038;
}

function seatbeltText(s: SeatbeltStatus): { value: string | null; severity: Severity } {
  if (s === 'fastened') return { value: 'Fastened', severity: 'good' };
  if (s === 'unfastened') return { value: 'Unfastened', severity: 'bad' };
  return { value: null, severity: 'neutral' };
}

/** Severity for tire pressure (kPa). 200–250 kPa is the typical normal band. */
function tireSeverity(kpa: number | null): Severity {
  if (kpa == null) return 'neutral';
  if (kpa < 150) return 'bad';      // dangerously low / flat
  if (kpa < 190 || kpa > 290) return 'warn';
  return 'good';
}

function coolantSeverity(c: number | null): Severity {
  if (c == null) return 'neutral';
  if (c >= 110) return 'bad';
  if (c >= 100 || c < 60) return 'warn';
  return 'good';
}

function oilTempSeverity(c: number | null): Severity {
  if (c == null) return 'neutral';
  if (c >= 130) return 'bad';
  if (c >= 120 || c < 60) return 'warn';
  return 'good';
}

function batterySeverity(v: number | null): Severity {
  if (v == null) return 'neutral';
  // <12.0 V resting = weak; engine running should be 13.5–14.8 V.
  if (v < 11.8 || v > 15.0) return 'bad';
  if (v < 12.4 || v > 14.8) return 'warn';
  return 'good';
}

function fuelLevelSeverity(pct: number | null): Severity {
  if (pct == null) return 'neutral';
  if (pct < 10) return 'bad';
  if (pct < 20) return 'warn';
  return 'good';
}

function fuelTrimSeverity(pct: number | null): Severity {
  if (pct == null) return 'neutral';
  // ±10% is healthy, ±10–25% is borderline, beyond that suggests a leak/sensor fault.
  const a = Math.abs(pct);
  if (a >= 25) return 'bad';
  if (a >= 10) return 'warn';
  return 'good';
}

function buildSections(d: OBDData): VitalSection[] {
  const tirePsi = (kpa: number | null): string | null => {
    const psi = kpaToPsi(kpa);
    return psi == null ? null : psi.toFixed(0);
  };

  const seatbelt = seatbeltText(d.seatbeltStatus);

  return [
    {
      // Anything here gets the driver's attention first — these are the "should I
      // be worried right now?" signals.
      title: 'Critical & Safety',
      subtitle: 'Watch these first',
      rows: [
        {
          label: 'Check Engine Light',
          value:
            d.milOn == null
              ? null
              : d.milOn
                ? `ON · ${d.dtcCount ?? 0} code${d.dtcCount === 1 ? '' : 's'}`
                : 'Off',
          severity: d.milOn == null ? 'neutral' : d.milOn ? 'bad' : 'good',
          hint: 'On means a stored diagnostic trouble code (DTC).',
        },
        {
          label: 'Coolant Temp',
          value: fmt(d.coolantC, 0),
          unit: '°C',
          severity: coolantSeverity(d.coolantC),
          hint: 'Normal 80–105°C. Above 110°C risks overheating.',
        },
        {
          label: 'Engine Oil Temp',
          value: fmt(d.oilTempC, 0),
          unit: '°C',
          severity: oilTempSeverity(d.oilTempC),
          hint: 'Normal 90–120°C. Sustained 130°C+ degrades oil.',
        },
        {
          label: 'Battery Voltage',
          value: fmt(d.batteryVolts, 1),
          unit: 'V',
          severity: batterySeverity(d.batteryVolts),
          hint: 'Engine off ≥12.4 V. Engine on 13.5–14.8 V.',
        },
        {
          label: 'Seatbelt (Driver)',
          value: seatbelt.value,
          severity: seatbelt.severity,
          hint: 'Manufacturer-specific PID; not all cars expose this.',
        },
        {
          label: 'Tire FL',
          value: tirePsi(d.tpmsFLKpa),
          unit: 'psi',
          severity: tireSeverity(d.tpmsFLKpa),
        },
        {
          label: 'Tire FR',
          value: tirePsi(d.tpmsFRKpa),
          unit: 'psi',
          severity: tireSeverity(d.tpmsFRKpa),
        },
        {
          label: 'Tire RL',
          value: tirePsi(d.tpmsRLKpa),
          unit: 'psi',
          severity: tireSeverity(d.tpmsRLKpa),
        },
        {
          label: 'Tire RR',
          value: tirePsi(d.tpmsRRKpa),
          unit: 'psi',
          severity: tireSeverity(d.tpmsRRKpa),
        },
      ],
    },
    {
      // Numbers the driver glances at while moving.
      title: 'Driving',
      subtitle: 'Live performance',
      rows: [
        {
          label: 'Speed',
          value: fmt(d.speedKmH, 0),
          unit: 'km/h',
        },
        {
          label: 'Engine RPM',
          value: fmt(d.rpm, 0),
          unit: 'rpm',
        },
        {
          label: 'Throttle Position',
          value: fmt(d.throttlePosPct, 0),
          unit: '%',
          hint: 'Pedal-derived; close to 0 at idle, ~100 wide-open.',
        },
        {
          label: 'Engine Load',
          value: fmt(d.engineLoadPct, 0),
          unit: '%',
          hint: 'How hard the engine is working vs. its peak.',
        },
        {
          label: 'Fuel Level',
          value: fmt(d.fuelLevelPct, 0),
          unit: '%',
          severity: fuelLevelSeverity(d.fuelLevelPct),
        },
        {
          label: 'Fuel Rate',
          value: fmt(d.fuelRateLPerH, 1),
          unit: 'L/h',
          hint:
            d.fuelCalcMethod === 'MAF'
              ? 'Computed from MAF (most accurate).'
              : d.fuelCalcMethod === 'MAP'
                ? 'Synthesized from MAP (fallback).'
                : 'No fuel-rate source available.',
        },
      ],
    },
    {
      // Mostly diagnostic — useful when chasing rough running, mileage drops, etc.
      title: 'Air & Fuel System',
      subtitle: 'Diagnostic signals',
      rows: [
        {
          label: 'Intake Air Temp',
          value: fmt(d.iatC, 0),
          unit: '°C',
        },
        {
          label: 'Ambient Air Temp',
          value: fmt(d.ambientTempC, 0),
          unit: '°C',
        },
        {
          label: 'MAF (mass air flow)',
          value: fmt(d.mafGPerS, 1),
          unit: 'g/s',
        },
        {
          label: 'MAP (manifold pressure)',
          value: fmt(d.mapKPa, 0),
          unit: 'kPa',
        },
        {
          label: 'Fuel Pressure',
          value: fmt(d.fuelPressureKPa, 0),
          unit: 'kPa',
          hint: 'Gauge pressure. Many modern cars do not expose this.',
        },
        {
          label: 'Short-Term Fuel Trim B1',
          value: fmt(d.shortFuelTrim1Pct, 1),
          unit: '%',
          severity: fuelTrimSeverity(d.shortFuelTrim1Pct),
          hint: 'Live correction. Healthy is ±10%.',
        },
        {
          label: 'Long-Term Fuel Trim B1',
          value: fmt(d.longFuelTrim1Pct, 1),
          unit: '%',
          severity: fuelTrimSeverity(d.longFuelTrim1Pct),
          hint: 'Persistent correction. >25% suggests a leak or sensor fault.',
        },
        {
          label: 'Timing Advance',
          value: fmt(d.timingAdvanceDeg, 1),
          unit: '° BTDC',
          hint: 'Ignition advance for cylinder 1.',
        },
        {
          label: 'Absolute Load',
          value: fmt(d.absoluteLoadPct, 0),
          unit: '%',
        },
        {
          label: 'Barometric Pressure',
          value: fmt(d.baroPressureKPa, 0),
          unit: 'kPa',
        },
      ],
    },
    {
      // Stuff that changes slowly or rarely — bottom of the screen.
      title: 'Trip & Diagnostic Counters',
      subtitle: 'Cumulative since clear or start',
      rows: [
        {
          label: 'Engine Run Time (trip)',
          value: fmtDuration(d.engineRunTimeSec),
        },
        {
          label: 'Distance Since Codes Cleared',
          value: fmt(d.distanceSinceClearedKm, 0),
          unit: 'km',
        },
        {
          label: 'Time Since Codes Cleared',
          value: fmtMinutes(d.timeSinceClearedMin),
        },
        {
          label: 'Distance With MIL On',
          value: fmt(d.distanceMilOnKm, 0),
          unit: 'km',
          severity: d.distanceMilOnKm == null ? 'neutral' : d.distanceMilOnKm > 0 ? 'warn' : 'good',
        },
        {
          label: 'Time With MIL On',
          value: fmtMinutes(d.timeMilOnMin),
          severity: d.timeMilOnMin == null ? 'neutral' : d.timeMilOnMin > 0 ? 'warn' : 'good',
        },
      ],
    },
  ];
}

export function VitalsScreen({ visible, onClose }: VitalsScreenProps) {
  const data = useOBDStore();
  // Skip the 30-field rebuild while the modal is hidden — OBD updates at ~4 Hz.
  const sections = useMemo(
    () => (visible ? buildSections(data) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, data.rpm, data.speedKmH, data.engineLoadPct, data.coolantC,
     data.milOn, data.dtcCount, data.fuelLevelPct, data.oilTempC,
     data.batteryVolts, data.throttlePosPct, data.fuelPressureKPa,
     data.ambientTempC, data.absoluteLoadPct, data.shortFuelTrim1Pct,
     data.longFuelTrim1Pct, data.timingAdvanceDeg, data.baroPressureKPa,
     data.engineRunTimeSec, data.distanceMilOnKm, data.distanceSinceClearedKm,
     data.timeMilOnMin, data.timeSinceClearedMin, data.mafGPerS, data.mapKPa,
     data.iatC, data.fuelRateLPerH, data.fuelCalcMethod,
     data.seatbeltStatus, data.tpmsFLKpa, data.tpmsFRKpa, data.tpmsRLKpa, data.tpmsRRKpa],
  );
  const isLive = data.state === 'ready';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
    >
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.title}>Car Vitals</Text>
            <Text style={styles.subtitle}>
              {isLive
                ? 'Live OBD-II data, ranked by importance'
                : 'OBD adapter not connected — values will appear once a connection is live'}
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.closeBtn}>
            <Text style={styles.closeText}>Close</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {sections.map((section) => (
            <View key={section.title} style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                <Text style={styles.sectionSubtitle}>{section.subtitle}</Text>
              </View>

              <View style={styles.card}>
                {section.rows.map((row, idx) => (
                  <View
                    key={row.label}
                    style={[styles.row, idx === section.rows.length - 1 && styles.rowLast]}
                  >
                    <View style={styles.rowText}>
                      <Text style={styles.rowLabel}>{row.label}</Text>
                      {row.hint ? <Text style={styles.rowHint}>{row.hint}</Text> : null}
                    </View>
                    <View style={styles.rowValueWrap}>
                      <Text
                        style={[
                          styles.rowValue,
                          { color: SEVERITY_COLORS[row.value == null ? 'neutral' : row.severity ?? 'neutral'] },
                          row.value == null && styles.rowValueDim,
                        ]}
                      >
                        {row.value ?? '—'}
                      </Text>
                      {row.unit ? <Text style={styles.rowUnit}>{row.unit}</Text> : null}
                    </View>
                  </View>
                ))}
              </View>
            </View>
          ))}

          <Text style={styles.footnote}>
            Many extended PIDs (oil temp, fuel level, ambient temp, fuel pressure, fuel trims, MIL
            counters) are optional in the OBD-II spec. Cars that don't expose a particular PID
            will show "—" indefinitely — that's expected.
          </Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0D0D0D',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  headerLeft: {
    flex: 1,
    paddingRight: 12,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  subtitle: {
    color: '#666',
    fontSize: 12,
    marginTop: 4,
    lineHeight: 17,
  },
  closeBtn: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  closeText: {
    color: '#3B82F6',
    fontSize: 15,
    fontWeight: '600',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
  },
  section: {
    marginBottom: 22,
  },
  sectionHeader: {
    paddingHorizontal: 4,
    marginBottom: 8,
  },
  sectionTitle: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  sectionSubtitle: {
    color: '#555',
    fontSize: 11,
    marginTop: 2,
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: '#111',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1A1A1A',
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
    minHeight: 52,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowText: {
    flex: 1,
    paddingRight: 12,
  },
  rowLabel: {
    color: '#E5E5E5',
    fontSize: 14,
    fontWeight: '500',
  },
  rowHint: {
    color: '#555',
    fontSize: 11,
    marginTop: 2,
    lineHeight: 15,
  },
  rowValueWrap: {
    flexDirection: 'row',
    alignItems: 'baseline',
    minWidth: 80,
    justifyContent: 'flex-end',
  },
  rowValue: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  rowValueDim: {
    color: '#333',
    fontWeight: '400',
  },
  rowUnit: {
    color: '#666',
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 4,
    letterSpacing: 0.5,
  },
  footnote: {
    color: '#444',
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 4,
    marginTop: 6,
  },
});
