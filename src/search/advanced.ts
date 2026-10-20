import { type AdvancedQuery, type SearchQuery, SearchQueryError } from './backend.js';
import { dateSpan } from './fields.js';

/** In code points, for basic and advanced queries */
const MAX_QUERY_LENGTH = 1024;
const MAX_DEPTH = 10;
/** Leaf clauses, counted after field groups are rewritten */
const MAX_CLAUSES = 64;

class InvalidQueryError extends Error {
  override name = 'InvalidQueryError';
}

type Token = {
  kind: '(' | ')' | ':' | 'phrase' | 'word' | 'AND' | 'OR' | 'NOT' | 'end';
  text: string;
  /** 1-based, in code points */
  position: number;
};

const OPERATORS: readonly string[] = ['AND', 'OR', 'NOT'];
const PUNCTUATION: readonly string[] = ['(', ')', ':'];

const isSpace = (char: string) => /\s/u.test(char);
const endsWord = (char: string) => isSpace(char) || PUNCTUATION.includes(char) || char === '"';

const tokenise = (chars: string[]) => {
  const tokens: Token[] = [];
  let at = 0;

  while (at < chars.length) {
    const char = chars[at];
    const position = at + 1;

    if (isSpace(char)) {
      at++;
    } else if (PUNCTUATION.includes(char)) {
      tokens.push({ kind: char as Token['kind'], text: char, position });
      at++;
    } else if (char === '"') {
      const close = chars.indexOf('"', at + 1);
      if (close === -1) {
        throw new InvalidQueryError(
          `Expected a closing " for the phrase at position ${position}, found the end of the query`,
        );
      }
      tokens.push({ kind: 'phrase', text: chars.slice(at + 1, close).join(''), position });
      at = close + 1;
    } else {
      const start = at;
      while (at < chars.length && !endsWord(chars[at])) {
        at++;
      }
      const text = chars.slice(start, at).join('');
      tokens.push({ kind: OPERATORS.includes(text) ? (text as Token['kind']) : 'word', text, position });
    }
  }

  tokens.push({ kind: 'end', text: '', position: chars.length + 1 });

  return tokens;
};

const describe = ({ kind, text }: Token) => {
  switch (kind) {
    case 'end':
      return 'the end of the query';
    case 'phrase':
      return `the phrase "${text}"`;
    case 'word':
      return `"${text}"`;
    default:
      return kind.length === 1 ? `"${kind}"` : kind;
  }
};

const combine = (type: 'and' | 'or', parts: AdvancedQuery[]): AdvancedQuery =>
  parts.length === 1
    ? parts[0]
    : { type, clauses: parts.flatMap((part) => (part.type === type ? part.clauses : [part])) };

const parse = (query: string, fields: Record<string, unknown>): AdvancedQuery => {
  const tokens = tokenise([...query]);
  let at = 0;

  const peek = (offset = 0) => tokens[at + offset];
  const fail = (expected: string): never => {
    throw new InvalidQueryError(`Expected ${expected} at position ${peek().position}, found ${describe(peek())}`);
  };
  const expect = (kind: Token['kind'], expected: string) => {
    if (peek().kind !== kind) {
      fail(expected);
    }
    at++;
  };

  // `field` is set inside a field group, where clauses are values rather than field matches
  const parseOr = (field?: string): AdvancedQuery => {
    const parts = [parseAnd(field)];
    while (peek().kind === 'OR') {
      at++;
      parts.push(parseAnd(field));
    }

    return combine('or', parts);
  };

  const parseAnd = (field?: string): AdvancedQuery => {
    const parts = [parseUnary(field)];
    while (peek().kind === 'AND') {
      at++;
      parts.push(parseUnary(field));
    }

    return combine('and', parts);
  };

  const parseUnary = (field?: string): AdvancedQuery => {
    if (peek().kind === 'NOT') {
      at++;

      return { type: 'not', clause: parseUnary(field) };
    }

    return parsePrimary(field);
  };

  const parseBracketed = (field?: string) => {
    at++;
    const clause = parseOr(field);
    expect(')', 'AND, OR or ")"');

    return clause;
  };

  const parsePrimary = (field?: string): AdvancedQuery => {
    if (peek().kind === '(') {
      return parseBracketed(field);
    }
    if (field !== undefined) {
      return parseValue(field);
    }

    const name = peek();
    if (name.kind !== 'word') {
      fail('a field name');
    }
    at++;
    expect(':', `":" after the field name "${name.text}"`);
    if (!Object.hasOwn(fields, name.text)) {
      throw new InvalidQueryError(`"${name.text}" at position ${name.position} isn't a declared advanced field`);
    }

    return peek().kind === '(' ? parseBracketed(name.text) : parseValue(name.text);
  };

  const startsValueWord = () => peek().kind === 'word' && peek(1).kind !== ':';

  const parseValue = (field: string): AdvancedQuery => {
    if (peek().kind === 'phrase') {
      const { text } = peek();
      at++;

      return { type: 'match', field, value: text, phrase: true };
    }

    if (!startsValueWord()) {
      fail(`a value for "${field}"`);
    }
    const words: string[] = [];
    while (startsValueWord()) {
      words.push(peek().text);
      at++;
    }

    return { type: 'match', field, value: words.join(' '), phrase: false };
  };

  const tree = parseOr();
  expect('end', 'AND, OR or the end of the query');

  return tree;
};

const depthOf = (query: AdvancedQuery): number => {
  switch (query.type) {
    case 'and':
    case 'or':
      return 1 + Math.max(...query.clauses.map(depthOf));
    case 'not':
      return 1 + depthOf(query.clause);
    default:
      return 0;
  }
};

const clausesIn = (query: AdvancedQuery): number => {
  switch (query.type) {
    case 'and':
    case 'or':
      return query.clauses.reduce((sum, clause) => sum + clausesIn(clause), 0);
    case 'not':
      return clausesIn(query.clause);
    default:
      return 1;
  }
};

const parseWithinCaps = (query: string, advancedFields: Record<string, unknown>): AdvancedQuery => {
  const tree = parse(query, advancedFields);
  if (depthOf(tree) > MAX_DEPTH) {
    throw new InvalidQueryError(`The query nests deeper than the limit of ${MAX_DEPTH} levels`);
  }
  if (clausesIn(tree) > MAX_CLAUSES) {
    throw new InvalidQueryError(`The query has more than the limit of ${MAX_CLAUSES} clauses`);
  }

  return tree;
};

/**
 * Check a query against the caps and parse an advanced one into a tree over `advancedFields`
 * A query arocapi refuses gives the problem instead
 */
export const normaliseQuery = (
  searchType: 'basic' | 'advanced',
  query: string,
  advancedFields: Record<string, unknown>,
): SearchQuery | { problem: string } => {
  if ([...query].length > MAX_QUERY_LENGTH) {
    return { problem: `The query is longer than the limit of ${MAX_QUERY_LENGTH} characters` };
  }
  if (searchType === 'basic') {
    return { searchType, query };
  }
  if (query.trim() === '') {
    return { searchType, query: { type: 'all' } };
  }

  try {
    return { searchType, query: parseWithinCaps(query, advancedFields) };
  } catch (error) {
    // Only InvalidQueryError is thrown: the parser is pure and its recursion is bounded by the length cap
    return { problem: (error as InvalidQueryError).message };
  }
};

/**
 * The UTC instants an advanced match on a date field covers, throwing a SearchQueryError for a value that isn't a date
 */
export const matchedDateSpan = (field: string, value: string) => {
  const span = dateSpan(value);
  if (!span) {
    throw new SearchQueryError(`"${field}" is a date field: "${value}" isn't a date`);
  }

  return span;
};
