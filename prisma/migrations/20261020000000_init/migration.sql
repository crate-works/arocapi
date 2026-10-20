-- CreateTable
CREATE TABLE "entity" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "memberOf" TEXT,
    "rootCollection" TEXT,
    "metadataLicenseId" TEXT NOT NULL,
    "contentLicenseId" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entity_memberOf_idx" ON "entity"("memberOf");

-- CreateIndex
CREATE INDEX "entity_rootCollection_idx" ON "entity"("rootCollection");

-- CreateIndex
CREATE INDEX "entity_entityType_idx" ON "entity"("entityType");

-- AddForeignKey
ALTER TABLE "file" ADD CONSTRAINT "file_id_fkey" FOREIGN KEY ("id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
