// Imported by scripts/buildOcflFixtures.ts under plain node, so it imports nothing

export const crate = JSON.stringify({
  '@context': 'https://w3id.org/ro/crate/1.2/context',
  '@graph': [{ name: 'Ŋaŋa' }],
});

/** The items every stored backend serves in the storage contract: a path below its root, and the bytes */
export const storedItems = [
  { path: 'collection/ro-crate-metadata.json', body: crate },
  { path: 'collection/item/greeting.wav', body: 'RIFF greeting bytes' },
  { path: 'collection/item/notes.bin', body: 'speaker,line\nŋaŋa,hello\n' },
] as const;
