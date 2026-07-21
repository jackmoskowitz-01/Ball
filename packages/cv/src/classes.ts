// Single source of truth for what we train to detect.
// Object classes: order = YOLO class id. Do not reorder after first training.
export const CLASSES = ['ball', 'player', 'rim', 'backboard', 'net', 'court'] as const;
export type CvClass = (typeof CLASSES)[number];

export const CLASS_IDS: Record<CvClass, number> = Object.fromEntries(
  CLASSES.map((c, i) => [c, i]),
) as Record<CvClass, number>;

// player_offense / player_defense collapse to 'player' for the detector;
// team is an attribute resolved downstream (jersey color / possession).
export function toDetectorClass(cls: string): CvClass | null {
  if (cls === 'player_offense' || cls === 'player_defense' || cls === 'player') return 'player';
  if ((CLASSES as readonly string[]).includes(cls)) return cls as CvClass;
  return null;
}

// Event keyframe classes for the event dataset (events.jsonl).
export const EVENT_CLASSES = [
  'shot_release',
  'rebound',
  'assist_pass',
  'block',
  'steal',
] as const;
export type CvEventClass = (typeof EVENT_CLASSES)[number];

export const EVENT_CLASS_IDS: Record<CvEventClass, number> = Object.fromEntries(
  EVENT_CLASSES.map((c, i) => [c, i]),
) as Record<CvEventClass, number>;

// DB EventAnnotation.type -> event dataset class
export const EVENT_TYPE_TO_CLASS: Record<string, CvEventClass | null> = {
  shot: 'shot_release',
  rebound: 'rebound',
  assist: 'assist_pass',
  block: 'block',
  steal: 'steal',
  possession_change: null, // derived, not a trained keyframe class
};
