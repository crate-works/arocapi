export type FieldType = 'text' | 'keyword' | 'date' | 'number' | 'boolean' | 'geo';

export type FieldDeclaration = {
  type: FieldType;
  label?: string;
  /** Text fields only: 1–4, default 1 */
  weight?: number;
  /** Default true for text fields */
  basic?: boolean;
  advanced?: boolean;
  filter?: boolean;
  /** Implies `filter`. Default size 20 */
  facet?: boolean | { size: number };
  sort?: boolean;
};

export type FieldDeclarations = Record<string, FieldDeclaration>;

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED: readonly string[] = ['id', 'AND', 'OR', 'NOT'];
const FIELD_TYPES: readonly string[] = ['text', 'keyword', 'date', 'number', 'boolean', 'geo'];

const isPositiveInteger = (value: number) => Number.isInteger(value) && value > 0;

const checkDeclaration = (name: string, declaration: FieldDeclaration) => {
  if (!FIELD_NAME.test(name)) {
    return `must match ${FIELD_NAME}`;
  }
  if (RESERVED.includes(name)) {
    return 'is reserved';
  }

  const { type, weight, facet } = declaration;
  if (!FIELD_TYPES.includes(type)) {
    return `has unknown type "${type}"`;
  }
  if (type === 'geo') {
    const role = (['basic', 'advanced', 'filter', 'facet', 'sort'] as const).find((r) => declaration[r]);
    if (role) {
      return `is a geo field, which can't have the ${role} role`;
    }
  }
  if (name === 'relevance' && declaration.sort) {
    return "can't be a sort field, as relevance is always a sort";
  }
  if (weight !== undefined && (type !== 'text' || !isPositiveInteger(weight) || weight > 4)) {
    return 'has a bad weight: only a text field has one, from 1 to 4';
  }
  if (typeof facet === 'object' && !isPositiveInteger(facet.size)) {
    return 'has a bad facet size: it must be a positive integer';
  }
  if (facet && type === 'number') {
    return "is a number field, which can't be a facet";
  }
  if (declaration.basic && type !== 'text' && type !== 'keyword') {
    return `is a ${type} field, which can't be in basic search`;
  }

  return undefined;
};

/**
 * Throw on a field declaration a search backend can't hold
 */
const validateFields = (fields: FieldDeclarations) => {
  let geoField: string | undefined;

  for (const [name, declaration] of Object.entries(fields)) {
    const problem = checkDeclaration(name, declaration);
    if (problem) {
      throw new Error(`Search field "${name}" ${problem}`);
    }

    if (declaration.type === 'geo') {
      if (geoField) {
        throw new Error(`Search field "${name}" is a second geo field, after "${geoField}": only one is allowed`);
      }
      geoField = name;
    }
  }
};

type Labelled = { label?: string };

/**
 * What a search backend publishes in `/capabilities` and arocapi validates requests against
 */
export type BackendSearchCapability = {
  filters: Record<string, Labelled & { type: 'string' | 'date' | 'number' | 'boolean' }>;
  facets: Record<string, Labelled>;
  sorts: Record<string, Labelled>;
  searchTypes: { basic: Record<string, never>; advanced?: { fields: Record<string, Labelled> } };
  geo: { supported: boolean };
};

/**
 * Derive a search backend's `/capabilities`-shaped capabilities from its field declarations
 */
export const capabilitiesFromFields = (fields: FieldDeclarations): BackendSearchCapability => {
  validateFields(fields);

  const declared = Object.entries(fields);
  const publish = <Published>(
    hasRole: (declaration: FieldDeclaration) => unknown,
    describe: (declaration: FieldDeclaration) => Published,
  ) =>
    Object.fromEntries(
      declared
        .filter(([, declaration]) => hasRole(declaration))
        .map(([name, declaration]) => [
          name,
          { ...describe(declaration), ...(declaration.label !== undefined && { label: declaration.label }) },
        ]),
    );

  const advanced = publish(
    ({ advanced }) => advanced,
    () => ({}),
  );

  return {
    filters: publish(isFilter, ({ type }) => ({
      type: type === 'text' || type === 'keyword' ? 'string' : (type as 'date' | 'number' | 'boolean'),
    })),
    facets: publish(
      ({ facet }) => facet,
      () => ({}),
    ),
    sorts: publish(
      ({ sort }) => sort,
      () => ({}),
    ),
    searchTypes: { basic: {}, ...(Object.keys(advanced).length > 0 && { advanced: { fields: advanced } }) },
    geo: { supported: declared.some(([, { type }]) => type === 'geo') },
  };
};

const isFilter = (declaration: FieldDeclaration) => Boolean(declaration.filter || declaration.facet);

export type GeoPoint = { lat: number; lng: number };

type ScalarOf<Type extends FieldType> = Type extends 'number'
  ? number
  : Type extends 'boolean'
    ? boolean
    : Type extends 'geo'
      ? GeoPoint
      : string;

type ValueOf<Declaration extends FieldDeclaration> = Declaration['type'] extends 'geo'
  ? GeoPoint
  : Declaration extends { sort: true }
    ? ScalarOf<Declaration['type']>
    : ScalarOf<Declaration['type']> | ScalarOf<Declaration['type']>[];

/**
 * One entity's values for the declared fields, as a consumer supplies it to a search backend
 */
export type SearchDocument<Fields extends FieldDeclarations = FieldDeclarations> = { id: string } & {
  -readonly [Name in keyof Fields]?: ValueOf<Fields[Name]>;
};

type StoredScalar = string | number | boolean | Date | GeoPoint;

/**
 * A validated search document: dates are their first UTC instant and missing fields are left out
 */
export type StoredSearchDocument = { id: string; values: Record<string, StoredScalar | StoredScalar[]> };

const DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})?)?)?)?$/;

export const parseDate = (value: string) => {
  const match = DATE.exec(value);
  if (!match) {
    return undefined;
  }

  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00', fraction = '', offset = 'Z'] =
    match;
  const parts = [year, month, day, hour, minute, second].map(Number);

  const date = new Date(0);
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  date.setUTCHours(parts[3], parts[4], parts[5], Number(fraction.padEnd(3, '0').slice(0, 3)));

  const stored = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ];
  if (stored.some((part, index) => part !== parts[index])) {
    return undefined;
  }

  if (offset.toUpperCase() !== 'Z') {
    const [offsetHours, offsetMinutes] = offset.slice(1).split(':').map(Number);
    if (offsetHours > 23 || offsetMinutes > 59) {
      return undefined;
    }
    const sign = offset.startsWith('-') ? -1 : 1;
    date.setTime(date.getTime() - sign * (offsetHours * 60 + offsetMinutes) * 60_000);
  }

  return date;
};

const isGeoPoint = (value: unknown): value is GeoPoint => {
  if (typeof value !== 'object' || value === null || Object.keys(value).length !== 2) {
    return false;
  }
  const { lat, lng } = value as Partial<GeoPoint>;

  return typeof lat === 'number' && typeof lng === 'number' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
};

type Stored = { value: StoredScalar } | { problem: string };

const storeScalar = (type: FieldType, value: unknown): Stored => {
  switch (type) {
    case 'text':
    case 'keyword':
      return typeof value === 'string' ? { value } : { problem: 'must be a string' };
    case 'date': {
      const date = typeof value === 'string' ? parseDate(value) : undefined;
      return date ? { value: date } : { problem: 'must be a YYYY, YYYY-MM, YYYY-MM-DD or RFC 3339 date' };
    }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? { value } : { problem: 'must be a finite number' };
    case 'boolean':
      return typeof value === 'boolean' ? { value } : { problem: 'must be a boolean' };
    case 'geo':
      return isGeoPoint(value)
        ? { value }
        : { problem: 'must be { lat, lng } with lat from -90 to 90 and lng from -180 to 180' };
  }
};

/**
 * Validate a batch of search documents against the field declarations, throwing on the first bad one
 */
export const storeDocuments = (fields: FieldDeclarations, docs: SearchDocument[]): StoredSearchDocument[] =>
  docs.map(({ id, ...rest }) => {
    if (typeof id !== 'string' || id === '') {
      throw new Error('Search document has no id');
    }

    const fail = (key: string, problem: string) => {
      throw new Error(`Search document "${id}": "${key}" ${problem}`);
    };

    const values: StoredSearchDocument['values'] = {};
    for (const [key, value] of Object.entries(rest)) {
      const declaration = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (!declaration) {
        return fail(key, "isn't a declared field");
      }
      if (Array.isArray(value) && (declaration.sort || declaration.type === 'geo')) {
        return fail(key, 'takes a single value, not an array');
      }

      const stored = (Array.isArray(value) ? value : [value]).map((item) => {
        const result = storeScalar(declaration.type, item);
        return 'value' in result ? result.value : fail(key, `${result.problem}, not ${JSON.stringify(item)}`);
      });
      values[key] = Array.isArray(value) ? stored : stored[0];
    }

    return { id, values };
  });
