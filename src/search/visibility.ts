import { type FieldDeclaration, type FieldDeclarations, type FieldType, parseDate } from './fields.js';

type ValueOf<Type extends FieldType> = Type extends 'number'
  ? number
  : Type extends 'boolean'
    ? boolean
    : Type extends 'date'
      ? string | Date
      : string;

type Equality<Value> = {
  equals?: Value | null;
  not?: Value | null;
  in?: Value[];
  notIn?: Value[];
};

type Ordered<Value> = { lt?: Value; lte?: Value; gt?: Value; gte?: Value };

type ConditionOf<Type extends FieldType> = Type extends 'date' | 'number'
  ? ValueOf<Type> | null | (Equality<ValueOf<Type>> & Ordered<ValueOf<Type>>)
  : ValueOf<Type> | null | Equality<ValueOf<Type>>;

type AnyCondition = ConditionOf<Exclude<FieldType, 'geo'>>;

type TypedWhere<Fields extends FieldDeclarations> = {
  AND?: TypedWhere<Fields>[];
  OR?: TypedWhere<Fields>[];
  NOT?: TypedWhere<Fields>[];
  id?: ConditionOf<'keyword'>;
} & {
  -readonly [Name in keyof Fields as Fields[Name]['type'] extends 'geo' ? never : Name]?: ConditionOf<
    Fields[Name]['type']
  >;
};

type UntypedWhere = {
  AND?: UntypedWhere[];
  OR?: UntypedWhere[];
  NOT?: UntypedWhere[];
  [name: string]: AnyCondition | UntypedWhere[] | undefined;
};

/**
 * A search visibility filter's condition over `id` and the declared fields, which every search backend applies
 */
export type SearchVisibilityWhere<Fields extends FieldDeclarations = FieldDeclarations> = string extends keyof Fields
  ? UntypedWhere
  : TypedWhere<Fields>;

type Scalar = string | number | boolean | Date;

/**
 * A checked search visibility filter, with dates as UTC instants
 */
export type VisibilityCondition =
  | { type: 'and' | 'or'; clauses: VisibilityCondition[] }
  | { type: 'not'; clause: VisibilityCondition }
  | { type: 'in'; field: string; values: Scalar[] }
  | { type: 'present'; field: string }
  | { type: 'range'; field: string; bounds: Partial<Record<'lt' | 'lte' | 'gt' | 'gte', number | Date>> };

const COMBINATORS = ['AND', 'OR', 'NOT'] as const;
const EQUALITY = ['equals', 'not', 'in', 'notIn'];
const RANGE = ['lt', 'lte', 'gt', 'gte'] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

const ID: FieldDeclaration = { type: 'keyword' };

/**
 * Check a search visibility filter against the field declarations, throwing an `Error` naming the field on any fault
 */
export const checkSearchVisibility = (fields: FieldDeclarations, where: unknown): VisibilityCondition => {
  const fail = (key: string, problem: string): never => {
    throw new Error(`Search visibility filter: "${key}" ${problem}`);
  };

  const scalar = (field: string, type: FieldType, value: unknown): Scalar => {
    switch (type) {
      case 'text':
      case 'keyword':
        return typeof value === 'string' ? value : fail(field, `must be a string, not ${JSON.stringify(value)}`);
      case 'number':
        return typeof value === 'number' && Number.isFinite(value)
          ? value
          : fail(field, `must be a finite number, not ${JSON.stringify(value)}`);
      case 'boolean':
        return typeof value === 'boolean' ? value : fail(field, `must be a boolean, not ${JSON.stringify(value)}`);
      default: {
        const date = value instanceof Date ? value : typeof value === 'string' ? parseDate(value) : undefined;
        return date && !Number.isNaN(date.getTime())
          ? date
          : fail(field, `must be a Date or a YYYY, YYYY-MM, YYYY-MM-DD or RFC 3339 date, not ${JSON.stringify(value)}`);
      }
    }
  };

  const equals = (field: string, type: FieldType, value: unknown): VisibilityCondition =>
    value === null
      ? { type: 'not', clause: { type: 'present', field } }
      : { type: 'in', field, values: [scalar(field, type, value)] };

  const list = (field: string, type: FieldType, operator: string, value: unknown): VisibilityCondition => {
    if (!Array.isArray(value)) {
      return fail(field, `takes an array for ${operator}`);
    }

    return { type: 'in', field, values: value.map((item) => scalar(field, type, item)) };
  };

  const condition = (field: string, declaration: FieldDeclaration, value: unknown): VisibilityCondition => {
    const { type } = declaration;
    if (type === 'geo') {
      return fail(field, "is a geo field, which a search visibility filter can't use");
    }
    if (!isPlainObject(value)) {
      return equals(field, type, value);
    }

    const ordered = type === 'date' || type === 'number';
    const clauses: VisibilityCondition[] = [];
    const bounds: Extract<VisibilityCondition, { type: 'range' }>['bounds'] = {};
    for (const [operator, operand] of Object.entries(value)) {
      if (operand === undefined) {
        continue;
      }
      if (ordered && (RANGE as readonly string[]).includes(operator)) {
        bounds[operator as (typeof RANGE)[number]] = scalar(field, type, operand) as number | Date;
        continue;
      }
      if (!EQUALITY.includes(operator)) {
        return fail(field, `is a ${type} field, which can't take ${operator}`);
      }

      const positive =
        operator === 'equals' || operator === 'not'
          ? equals(field, type, operand)
          : list(field, type, operator, operand);
      clauses.push(operator === 'not' || operator === 'notIn' ? { type: 'not', clause: positive } : positive);
    }
    if (Object.keys(bounds).length > 0) {
      clauses.push({ type: 'range', field, bounds });
    }

    return clauses.length === 1 ? clauses[0] : { type: 'and', clauses };
  };

  const check = (node: unknown, path: string): VisibilityCondition => {
    if (!isPlainObject(node)) {
      return fail(path, 'must be an object of field conditions');
    }

    const clauses: VisibilityCondition[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (value === undefined) {
        continue;
      }

      if ((COMBINATORS as readonly string[]).includes(key)) {
        if (!Array.isArray(value)) {
          return fail(key, 'takes an array of filters');
        }
        const nested = value.map((item, index) => check(item, `${key}[${index}]`));
        clauses.push(
          key === 'AND'
            ? { type: 'and', clauses: nested }
            : key === 'OR'
              ? { type: 'or', clauses: nested }
              : { type: 'not', clause: { type: 'or', clauses: nested } },
        );
        continue;
      }

      const declaration = key === 'id' ? ID : Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (!declaration) {
        return fail(key, "isn't a declared field");
      }
      clauses.push(condition(key, declaration, value));
    }

    return clauses.length === 1 ? clauses[0] : { type: 'and', clauses };
  };

  return check(where, 'filter');
};
