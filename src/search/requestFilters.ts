import { z } from 'zod';
import type { BackendSearchCapability, BoundingBox, RangeBound, RangeFilter, SearchRequest } from './backend.js';
import { dateSpan } from './fields.js';
import type { VisibilityCondition } from './visibility.js';

const boundSchema = z.union([z.string(), z.number()]);
const rangeSchema = z
  .strictObject({ gte: boundSchema.optional(), lte: boundSchema.optional() })
  .refine(({ gte, lte }) => gte !== undefined || lte !== undefined, 'A range needs gte, lte or both');

/** A filter's value on the wire: exact values, a range, or ranges any of which matches */
export const filterValueSchema = z.union([z.array(z.string()), rangeSchema, z.array(rangeSchema).min(1)]);

const pointSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

export const boundingBoxSchema = z.object({ topRight: pointSchema, bottomLeft: pointSchema });

type WireRange = z.infer<typeof rangeSchema>;
type FilterValue = z.infer<typeof filterValueSchema>;
type FilterType = BackendSearchCapability['filters'][string]['type'];
type Violation = { field: string; message: string; value?: unknown };
type Normalised = { range: RangeFilter } | { problem: string };

const FILTER_DATE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]|$)/;
const DATE_FORMS = 'a YYYY-MM-DD date or an RFC 3339 date-time';

/** Filters take a calendar date, covering its whole UTC day, or a date-time */
const filterDateSpan = (value: string) => (FILTER_DATE.test(value) ? dateSpan(value) : undefined);

const toBound = (type: 'date' | 'number', side: 'gte' | 'lte', value: string | number): RangeBound | undefined => {
  if (type === 'number') {
    return typeof value === 'number' ? value : undefined;
  }

  const span = typeof value === 'string' ? filterDateSpan(value) : undefined;

  return span && (side === 'gte' ? span.first : span.last);
};

const normaliseRange = (type: 'date' | 'number', range: WireRange): Normalised => {
  const normalised: RangeFilter = {};
  for (const side of ['gte', 'lte'] as const) {
    const value = range[side];
    if (value === undefined) {
      continue;
    }

    const bound = toBound(type, side, value);
    if (bound === undefined) {
      return { problem: `${side} must be ${type === 'date' ? DATE_FORMS : 'a number'}` };
    }
    normalised[side] = bound;
  }

  const { gte, lte } = normalised;
  if (gte !== undefined && lte !== undefined && Number(gte) > Number(lte)) {
    return { problem: 'has gte above lte' };
  }

  return { range: normalised };
};

const exactRange = (type: 'date' | 'number', value: string): Normalised => {
  if (type === 'number') {
    const number = Number(value);

    return value.trim() !== '' && Number.isFinite(number)
      ? { range: { gte: number, lte: number } }
      : { problem: `values must be numbers, not ${JSON.stringify(value)}` };
  }

  const span = filterDateSpan(value);

  return span
    ? { range: { gte: span.first, lte: span.last } }
    : { problem: `values must be ${DATE_FORMS}, not ${JSON.stringify(value)}` };
};

const isExact = (value: FilterValue): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const normalise = (type: FilterType, value: FilterValue): { range: RangeFilter[] } | { problem: string } => {
  if (type !== 'date' && type !== 'number') {
    return { problem: `is a ${type} filter, which takes exact values, not ranges` };
  }

  const normalised = isExact(value)
    ? value.map((item) => exactRange(type, item))
    : (Array.isArray(value) ? value : [value]).map((range) => normaliseRange(type, range));
  const failed = normalised.find((item) => 'problem' in item);

  return failed ?? { range: normalised.map((item) => (item as { range: RangeFilter }).range) };
};

/**
 * Split declared filters into exact terms and ranges: date and number filters become ranges, with dates as UTC instants
 * Undeclared keys are left for the caller to reject
 */
export const splitFilters = (declared: BackendSearchCapability['filters'], filters: Record<string, FilterValue>) => {
  const split: SearchRequest['filters'] = { terms: {}, ranges: {} };
  const violations: Violation[] = [];

  for (const [key, value] of Object.entries(filters)) {
    if (!Object.hasOwn(declared, key)) {
      continue;
    }

    const { type } = declared[key];
    if ((type === 'string' || type === 'boolean') && isExact(value)) {
      const notBoolean = type === 'boolean' ? value.find((item) => item !== 'true' && item !== 'false') : undefined;
      if (notBoolean === undefined) {
        split.terms[key] = value;
      } else {
        violations.push({
          field: `/filters/${key}`,
          message: `${key} values must be true or false, not ${JSON.stringify(notBoolean)}`,
          value,
        });
      }
      continue;
    }

    const result = normalise(type, value);
    if ('problem' in result) {
      violations.push({ field: `/filters/${key}`, message: `${key} ${result.problem}`, value });
    } else {
      split.ranges[key] = result.range;
    }
  }

  return { filters: split, violations };
};

/**
 * A request's filters as one condition: each filter must match, by any of its values or ranges
 */
export const filtersCondition = ({ terms, ranges }: SearchRequest['filters']): VisibilityCondition => ({
  type: 'and',
  clauses: [
    ...Object.entries(terms).map(([field, values]): VisibilityCondition => ({ type: 'in', field, values })),
    ...Object.entries(ranges).map(
      ([field, filters]): VisibilityCondition => ({
        type: 'or',
        clauses: filters.map((bounds) => ({ type: 'range', field, bounds })),
      }),
    ),
  ],
});

/**
 * Problems with a request's geo parameters, given whether the backend supports geo
 */
export const geoViolations = (
  geo: BackendSearchCapability['geo'],
  { boundingBox, geohashPrecision }: { boundingBox?: BoundingBox; geohashPrecision?: number },
): Violation[] => {
  const unsupported = "Geo search isn't supported";
  if (!geo.supported) {
    return [
      ...(boundingBox ? [{ field: '/boundingBox', message: unsupported }] : []),
      ...(geohashPrecision === undefined ? [] : [{ field: '/geohashPrecision', message: unsupported }]),
    ];
  }

  return [
    ...(geohashPrecision !== undefined && !boundingBox
      ? [{ field: '/geohashPrecision', message: 'geohashPrecision needs a boundingBox' }]
      : []),
    ...(boundingBox && boundingBox.bottomLeft.lat > boundingBox.topRight.lat
      ? [{ field: '/boundingBox', message: 'bottomLeft.lat is north of topRight.lat' }]
      : []),
  ];
};
