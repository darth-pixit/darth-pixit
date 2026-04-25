export type VehicleFamily = '2w' | '4w';

export interface MetricMeta {
  key: string;
  label: string;
  appliesTo: VehicleFamily[];
  /** Display order for 2W; 0 = not shown for this family. */
  order2w: number;
  /** Display order for 4W; 0 = not shown for this family. */
  order4w: number;
}

export const METRICS: Record<string, MetricMeta> = {
  speeding:     { key: 'speeding',     label: 'Speeding',      appliesTo: ['2w', '4w'], order2w: 1, order4w: 1 },
  braking:      { key: 'braking',      label: 'Braking',       appliesTo: ['2w', '4w'], order2w: 2, order4w: 2 },
  phone:        { key: 'phone',        label: 'Phone Use',     appliesTo: ['2w', '4w'], order2w: 3, order4w: 3 },
  lane_change:  { key: 'lane_change',  label: 'Lane Changes',  appliesTo: ['4w'],       order2w: 0, order4w: 4 },
  seatbelt:     { key: 'seatbelt',     label: 'Seatbelt',      appliesTo: ['4w'],       order2w: 0, order4w: 5 },
  cornering:    { key: 'cornering',    label: 'Cornering',     appliesTo: ['2w', '4w'], order2w: 4, order4w: 6 },
  accel:        { key: 'accel',        label: 'Acceleration',  appliesTo: ['2w', '4w'], order2w: 5, order4w: 7 },
  drowsy:       { key: 'drowsy',       label: 'Drowsiness',    appliesTo: ['2w'],       order2w: 6, order4w: 0 },
  engine_abuse: { key: 'engine_abuse', label: 'Engine Abuse',  appliesTo: ['4w'],       order2w: 0, order4w: 8 },
  idling:       { key: 'idling',       label: 'Idling',        appliesTo: ['4w'],       order2w: 0, order4w: 9 },
};

export const COMPOSITE_WEIGHTS: Record<VehicleFamily, Record<string, number>> = {
  '2w': {
    speeding:  0.25,
    braking:   0.20,
    cornering: 0.18,
    phone:     0.15,
    accel:     0.12,
    drowsy:    0.10,
  },
  '4w': {
    speeding:     0.22,
    braking:      0.20,
    phone:        0.18,
    lane_change:  0.10,
    seatbelt:     0.08,
    cornering:    0.08,
    accel:        0.07,
    engine_abuse: 0.04,
    idling:       0.03,
  },
};

export function metricsForFamily(family: VehicleFamily): MetricMeta[] {
  return Object.values(METRICS)
    .filter(m => m.appliesTo.includes(family))
    .sort((a, b) => {
      const oa = family === '2w' ? a.order2w : a.order4w;
      const ob = family === '2w' ? b.order2w : b.order4w;
      return oa - ob;
    });
}

export function scoreColor(score: number | null): string {
  if (score === null) return '#444';
  if (score >= 85) return '#22C55E';
  if (score >= 70) return '#F59E0B';
  if (score >= 55) return '#F97316';
  return '#EF4444';
}

export function scoreLabel(score: number | null): string {
  if (score === null) return 'No Data';
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 55) return 'Fair';
  return 'Needs Work';
}
