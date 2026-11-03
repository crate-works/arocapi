import type { FileTransformer, Options } from 'arocapi';

const addSizeInKb: FileTransformer = (file) => ({ ...file, sizeInKb: Math.round(file.size / 1024) });

// Copy only the values you need from the row; never send `meta` as-is
const addChecksum: FileTransformer = (file, _context, row) => {
  const meta = row.meta as { checksum?: string } | null;
  const entityMeta = row.entity.meta as { accessControl?: string } | null;

  return { ...file, checksum: meta?.checksum, accessControl: entityMeta?.accessControl ?? 'Public' };
};

export const fileTransformers: Options['fileTransformers'] = [addSizeInKb, addChecksum];
