// Shared basketball ontology types. The DB stores objects/events as JSON
// matching these shapes; the CV layer and both apps import from here.

export type ObjectClass =
  | 'ball'
  | 'player_offense'
  | 'player_defense'
  | 'player' // team unknown yet
  | 'rim'
  | 'backboard'
  | 'net'
  | 'court';

export interface BBox {
  x: number; // top-left, pixels in source video space
  y: number;
  w: number;
  h: number;
}

export interface ObjectAnnotation extends BBox {
  id: string; // stable annotation id within the frame
  cls: ObjectClass;
  trackingId: number | null; // persistent across frames (ball + players); null for court/rim until assigned
  occluded: boolean;
  blurry: boolean;
  visible: boolean;
  vx: number | null; // px/frame, from interpolation or tracker
  vy: number | null;
  jerseyNumber: string | null;
  confidence: number | null; // teacher confidence; null for human labels
  // court only: polygon points override bbox. First polygon = boundary,
  // named sub-polygons for paint / 3pt.
  polygon?: { x: number; y: number }[];
  polygonKind?: 'boundary' | 'paint' | 'three_pt' | 'ft_line';
}

export type FrameObjects = ObjectAnnotation[];

export type EventType =
  | 'shot'
  | 'rebound'
  | 'assist'
  | 'block'
  | 'steal'
  | 'possession_change';

export type ShotResult = 'make' | 'miss';
export type ShotType = '2pt' | '3pt' | 'ft';
export type ReboundType = 'offensive' | 'defensive';

// Frame-role names, per event type, that the label UI + export care about.
export interface EventPayload {
  // shot
  gatherFrame?: number;
  releaseFrame?: number; // KEYFRAME for shot
  apexFrame?: number;
  endFrame?: number;
  result?: ShotResult;
  shotType?: ShotType;
  shooterTrackingId?: number;
  // rebound
  startFrame?: number; // ball hits rim/backboard
  rebounderTrackingId?: number;
  reboundType?: ReboundType;
  // assist
  passFrame?: number;
  shotReleaseFrame?: number;
  assisterTrackingId?: number;
  // block
  blockFrame?: number;
  blockerTrackingId?: number;
  // steal
  stealFrame?: number;
  stealerTrackingId?: number;
  loserTrackingId?: number;
  // possession_change
  fromTrackingId?: number;
  toTrackingId?: number;
}

export interface EventKeyframeFeatures {
  vx: number | null;
  vy: number | null;
  wrist_y: number | null;
  elbow_y: number | null;
  ball_in_hand_dist: number | null;
}

// One line of data/realtime/events.jsonl
export interface EventSample extends EventKeyframeFeatures {
  framePath: string;
  eventType: 'shot_release' | 'rebound' | 'assist_pass' | 'block' | 'steal';
  participants: number[]; // trackingIds
}

export interface TeacherFrame {
  frameNumber: number;
  objects: FrameObjects;
}

export interface TeacherEventProposal {
  type: EventType;
  keyFrame: number;
  payload: EventPayload;
  confidence: number;
}

export interface TeacherResult {
  fps: number;
  width: number;
  height: number;
  frameCount: number;
  frames: TeacherFrame[];
  events: TeacherEventProposal[];
}

export interface StudentDetection extends BBox {
  cls: ObjectClass;
  confidence: number;
  trackingId: number | null;
}
