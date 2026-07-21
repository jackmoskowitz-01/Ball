-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "fps" REAL NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "frames" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "holdout" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LabelVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LabelVersion_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Label" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "versionId" TEXT,
    "frameNumber" INTEGER NOT NULL,
    "objects" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "minConfidence" REAL,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "usedInTraining" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Label_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Label_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "LabelVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EventAnnotation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "keyFrame" INTEGER NOT NULL,
    "startFrame" INTEGER,
    "endFrame" INTEGER,
    "payload" TEXT NOT NULL,
    "features" TEXT,
    "source" TEXT NOT NULL,
    "confidence" REAL,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "usedInTraining" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EventAnnotation_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DatasetVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL,
    "classCounts" TEXT NOT NULL,
    "labelCount" INTEGER NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TrainingJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "datasetVersionId" TEXT,
    "log" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "TrainingJob_datasetVersionId_fkey" FOREIGN KEY ("datasetVersionId") REFERENCES "DatasetVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "weightsPath" TEXT NOT NULL,
    "metrics" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "trainingJobId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelVersion_trainingJobId_fkey" FOREIGN KEY ("trainingJobId") REFERENCES "TrainingJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Label_isApproved_usedInTraining_idx" ON "Label"("isApproved", "usedInTraining");

-- CreateIndex
CREATE INDEX "Label_minConfidence_idx" ON "Label"("minConfidence");

-- CreateIndex
CREATE UNIQUE INDEX "Label_videoId_frameNumber_source_key" ON "Label"("videoId", "frameNumber", "source");

-- CreateIndex
CREATE INDEX "EventAnnotation_videoId_type_idx" ON "EventAnnotation"("videoId", "type");

-- CreateIndex
CREATE INDEX "EventAnnotation_isApproved_usedInTraining_idx" ON "EventAnnotation"("isApproved", "usedInTraining");

-- CreateIndex
CREATE UNIQUE INDEX "DatasetVersion_version_key" ON "DatasetVersion"("version");

-- CreateIndex
CREATE INDEX "ModelVersion_type_status_idx" ON "ModelVersion"("type", "status");
