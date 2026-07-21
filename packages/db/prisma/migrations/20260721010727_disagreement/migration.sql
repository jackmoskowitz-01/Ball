-- AlterTable
ALTER TABLE "Label" ADD COLUMN "disagreement" REAL;

-- CreateIndex
CREATE INDEX "Label_disagreement_idx" ON "Label"("disagreement");
