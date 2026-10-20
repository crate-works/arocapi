-- CreateTable
CREATE TABLE "entity_search" (
    "id" TEXT NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "basic" tsvector NOT NULL,
    "text" tsvector NOT NULL,
    "point" point,
    "geohash" TEXT,

    CONSTRAINT "entity_search_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entity_search_values_idx" ON "entity_search" USING GIN ("values");

-- CreateIndex
CREATE INDEX "entity_search_basic_idx" ON "entity_search" USING GIN ("basic");

-- CreateIndex
CREATE INDEX "entity_search_text_idx" ON "entity_search" USING GIN ("text");

-- CreateIndex
CREATE INDEX "entity_search_point_idx" ON "entity_search" USING GIST ("point");

-- AddForeignKey
ALTER TABLE "entity_search" ADD CONSTRAINT "entity_search_id_fkey" FOREIGN KEY ("id") REFERENCES "entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
