/**
 * @migrationguard/core
 * Core domain types, connector contracts, deterministic transformation engine,
 * schema discovery, data profiling, mapping DSL, and canonical hashing.
 */

export * from './types/index.js';
export * from './canonical/index.js';
export * from './transforms/index.js';
export * from './mapping/index.js';
export * from './profiling/index.js';
export * from './discovery/index.js';
export * from './connectors/index.js';
export {
  CountValidator,
  MissingRecordValidator,
  ExtraRecordValidator,
  DuplicateValidator,
  HashValidator,
  FieldValidator,
  AttachmentValidator,
  RelationshipValidator,
  MetadataValidator,
  ValidationEngine,
  generateSyntheticDataset,
  injectFaults,
  type ValidationDataset,
  type ValidationRunSummary,
} from './validator/index.js';
export * from './reports/index.js';
export * from './utils/sanitizer.js';
