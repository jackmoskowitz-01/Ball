# KEEP IN SYNC with packages/cv/src/classes.ts
CLASSES = ["ball", "player", "rim", "backboard", "net", "court"]
CLASS_IDS = {c: i for i, c in enumerate(CLASSES)}
EVENT_CLASSES = ["shot_release", "rebound", "assist_pass", "block", "steal"]
EVENT_CLASS_IDS = {c: i for i, c in enumerate(EVENT_CLASSES)}

# COCO ids used when falling back to pretrained weights (no fine-tune yet)
COCO_PERSON = 0
COCO_SPORTS_BALL = 32
