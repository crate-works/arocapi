# Sample Language Documentation Data

This directory contains realistic sample data for testing and development of the AROCAPI system. The data represents two language documentation collections with authentic RO-Crate metadata, audio files, and ELAN annotation files.

## Contents

The sample data consists of **2 collections** with **3 items each** (6 items total):

### Collection 1: Nyeleni Language Documentation Archive

A West African endangered language documentation project.

- **Collection ID**: `http://example.com/collection/nyeleni-001`
- **Language**: Nyeleni (nya)
- **Location**: Mopti Region, Mali
- **License**: CC BY-NC-SA 4.0 (content), CC BY 4.0 (metadata)
- **Depositor**: Dr. Aminata Koné, University of Bamako

**Items:**

1. **Traditional Greetings** (`item-01-greeting`)
   - Speaker: Elder Mamadou Diarra
   - Duration: 3 seconds
   - Includes formal greetings and health inquiries

2. **The Tale of the Clever Hare** (`item-02-story`)
   - Narrator: Fatoumata Traoré
   - Duration: 4.5 seconds
   - Traditional folktale with moral lessons

3. **Kinship Terms Elicitation** (`item-03-vocabulary`)
   - Consultant: Sekou Keita
   - Duration: 4 seconds
   - Structured vocabulary session on family terms

### Collection 2: Coastal Dialects Archive

A Pacific coastal language documentation project.

- **Collection ID**: `http://example.com/collection/coastal-001`
- **Language**: Pacific Coastal Language (pac)
- **Location**: Northern Pacific Coast
- **License**: CC BY-NC-ND 4.0 (content), CC BY 4.0 (metadata)
- **Depositor**: Dr. Sarah Chen, Pacific Coast University

**Items:**

1. **The Great Storm - Personal Narrative** (`item-01-narrative`)
   - Speaker: William Johnson
   - Duration: 5 seconds
   - Historical account from 1962

2. **Traditional Fishing Songs** (`item-02-songs`)
   - Singer: Mary Thompson
   - Duration: 3.5 seconds
   - Songs performed before launching boats

3. **Preparing the Net - Conversation** (`item-03-conversation`)
   - Speakers: James Wilson & Robert Anderson
   - Duration: 4.2 seconds
   - Natural conversation about traditional net-making

## File Structure

```
example/data/
├── README.md                           # This file
├── seed.ts                             # Database seeding script
├── generate-wav.ts                     # Script to regenerate WAV files
│
├── collection-01-nyeleni/
│   ├── ro-crate-metadata.json         # Collection-level metadata
│   ├── item-01-greeting/
│   │   ├── ro-crate-metadata.json     # Item metadata
│   │   ├── greeting.wav               # Audio recording (3s, 440Hz)
│   │   └── greeting.eaf               # ELAN annotations
│   ├── item-02-story/
│   │   ├── ro-crate-metadata.json
│   │   ├── story.wav                  # Audio recording (4.5s, 523Hz)
│   │   └── story.eaf
│   └── item-03-vocabulary/
│       ├── ro-crate-metadata.json
│       ├── vocabulary.wav             # Audio recording (4s, 587Hz)
│       └── vocabulary.eaf
│
└── collection-02-coastal/
    ├── ro-crate-metadata.json
    ├── item-01-narrative/
    │   ├── ro-crate-metadata.json
    │   ├── narrative.wav              # Audio recording (5s, 659Hz)
    │   └── narrative.eaf
    ├── item-02-songs/
    │   ├── ro-crate-metadata.json
    │   ├── songs.wav                  # Audio recording (3.5s, 698Hz)
    │   └── songs.eaf
    └── item-03-conversation/
        ├── ro-crate-metadata.json
        ├── conversation.wav           # Audio recording (4.2s, 784Hz)
        └── conversation.eaf
```

## RO-Crate Metadata

Each collection and item includes comprehensive RO-Crate metadata following the [RO-Crate 1.1 specification](https://www.researchobject.org/ro-crate/):

### Collection-Level Metadata

- Collection name and description
- Geographic location with coordinates
- Primary language with ISO 639-3 codes
- Depositor information
- Institutional affiliation
- License information (separate for content and metadata)
- Links to all items in the collection

### Item-Level Metadata

- Item name and description
- Recording date and genre
- Speaker/contributor information
- Language information
- File parts (audio + annotation)
- Relationship to parent collection
- License information

## Audio Files (WAV)

All WAV files are real audio files with valid WAV format headers:

- **Format**: 16-bit PCM, mono, 44.1kHz
- **Content**: Sine wave tones at different frequencies
- **Durations**: 3-5 seconds each
- **Size**: ~50-150KB each
- **Features**: Fade in/out to prevent clicks

Each item has a unique tone frequency for easy identification during testing.

## ELAN Annotation Files (.eaf)

ELAN files follow the [ELAN Annotation Format (EAF) 3.0](https://www.mpi.nl/tools/elan/) specification:

### Tier Structure

1. **Transcription tier**: Time-aligned transcription in the source language
2. **Translation tier**: Free English translation (symbolic association)
3. **Additional tiers**: Notes, glosses, or discourse structure (varies by item)

### Features

- Time-aligned annotations with millisecond precision
- Multiple participants (for conversation)
- Linguistic type definitions
- Language metadata (ISO 639-3)
- Realistic linguistic content with proper orthography

## Usage

### Loading Sample Data

To seed your local database with this sample data:

```bash
# From the example directory
pnpm run seed
```

This will:
1. Clear existing entities from the database
2. Load both collections and all items
3. Create OpenSearch index with proper mappings
4. Index all entities for search

### Regenerating WAV Files

If you need to regenerate the audio files:

```bash
# From the example directory
pnpm run generate-wav
```

### Testing with Sample Data

The sample data can be used to test:

- **Entity retrieval**: `GET /entity/{rocrateId}`
- **Collection browsing**: `GET /entities?memberOf={collectionId}`
- **Search functionality**: `POST /search` with various queries
- **Access control**: Different licenses between collections
- **Language filtering**: ISO 639-3 language codes
- **Geographic search**: GeoJSON coordinates in metadata

### Example API Queries

```bash
# Get a collection
GET /entity/http%3A%2F%2Fexample.com%2Fcollection%2Fnyeleni-001

# Get all items in a collection
GET /entities?memberOf=http://example.com/collection/nyeleni-001

# Search for greetings
POST /search
{
  "query": {
    "match": {
      "description": "greeting"
    }
  }
}
```

## Data Characteristics

### Realistic Features

- **Authentic metadata structure**: Based on real language documentation projects
- **Proper licensing**: Different CC licenses between collections
- **Geographic diversity**: West Africa and Pacific Coast locations
- **Genre variety**: Greetings, stories, elicitation, narratives, songs, conversation
- **Multi-speaker content**: Includes items with multiple contributors
- **Cultural context**: Annotations include cultural and linguistic notes

### Simplifications

- **Audio content**: Simple sine wave tones instead of actual speech
- **Language codes**: Fictional language codes (nya, pac) for demonstration
- **Entity IDs**: Simple HTTP URIs instead of production identifiers
- **File sizes**: Smaller than production files for faster testing

## License

This sample data is provided for testing and development purposes only.

- **Metadata**: CC BY 4.0
- **Collection 1 content**: CC BY-NC-SA 4.0 (fictional license for testing)
- **Collection 2 content**: CC BY-NC-ND 4.0 (fictional license for testing)

All speaker names, locations, and linguistic content are fictional and created solely for demonstration purposes.

## Maintenance

### Updating Metadata

To modify the RO-Crate metadata:

1. Edit the appropriate `ro-crate-metadata.json` file
2. Re-run the seed script to update the database
3. Ensure the JSON-LD is valid RO-Crate 1.1 format

### Adding New Items

To add new items to a collection:

1. Create a new directory under the collection
2. Add `ro-crate-metadata.json`, WAV, and EAF files
3. Update the collection's `ro-crate-metadata.json` to include the new item
4. Update `seed.ts` to process the new item
5. Run `pnpm run seed`

### Regenerating Files

- **WAV files**: Modify `generate-wav.ts` and run `pnpm run generate-wav`
- **ELAN files**: Manually edit the XML or use ELAN software

## Technical Details

### Database Schema

Entities are stored in the `Entity` table with:

- `rocrateId`: Unique identifier (text)
- `name`: Entity name (text)
- `description`: Text description
- `entityType`: Schema.org or PCDM type
- `memberOf`: Parent collection reference
- `rootCollection`: Top-level collection reference
- `metadataLicenseId`: License for metadata
- `contentLicenseId`: License for content
- `meta`: Storage metadata (JSON, optional)

Note: RO-Crate metadata is served via the `/entity/:id/rocrate` endpoint using the configured `roCrateHandler`, not stored in the database.

### OpenSearch Mappings

The search index includes:

- Keyword fields: `rocrateId`, `entityType`, `memberOf`, `inLanguage`
- Text fields: `name`, `description`
- Structured fields: `location` (geo_point)

## References

- [RO-Crate Specification](https://www.researchobject.org/ro-crate/)
- [ELAN Annotation Format](https://www.mpi.nl/tools/elan/)
- [Portland Common Data Model (PCDM)](https://pcdm.org/)
- [Schema.org](https://schema.org/)
- [Creative Commons Licenses](https://creativecommons.org/licenses/)
