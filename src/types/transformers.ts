import type { AuthorisedEntity, AuthorisedFile, EntityRow } from '../transformers/default.js';
import type { RequestContext } from './context.js';

/**
 * Entity transformer function
 * Receives AuthorisedEntity and transforms it further
 * Transformers are applied as a pipeline, with each transformer receiving
 * the output of the previous one, and every transformer receiving the entity's row
 */
export type EntityTransformer<TInput = AuthorisedEntity, TOutput = TInput> = (
  entity: TInput,
  context: RequestContext,
  row: EntityRow,
) => Promise<TOutput> | TOutput;

/**
 * File transformer function
 * Receives AuthorisedFile and transforms it further
 * Transformers are applied as a pipeline, with each transformer receiving
 * the output of the previous one
 */
export type FileTransformer<TInput = AuthorisedFile, TOutput = TInput> = (
  file: TInput,
  context: RequestContext,
) => Promise<TOutput> | TOutput;
