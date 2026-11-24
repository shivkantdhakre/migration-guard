import type { MigrationPlan, DryRunResult } from './types';

export interface DryRunEvaluation {
  success: boolean;
  error: string | null;
}

/**
 * Resolves the valid migration plan version ID.
 * Strictly verifies plan.versionId or plan.versions[latest].id.
 * NEVER conflates plan.id (plan container ID) with versionId (executable plan version ID).
 */
export function resolvePlanVersionId(plan: MigrationPlan | null | undefined): string | null {
  if (!plan) return null;
  if (plan.versionId && typeof plan.versionId === 'string' && plan.versionId.trim().length > 0) {
    return plan.versionId.trim();
  }
  if (Array.isArray(plan.versions) && plan.versions.length > 0) {
    const latest = plan.versions[plan.versions.length - 1];
    if (latest?.id && typeof latest.id === 'string' && latest.id.trim().length > 0) {
      return latest.id.trim();
    }
  }
  return null;
}

/**
 * Strict evaluation of dry run backend response.
 * Eliminates all false-success paths and rejects missing/malformed metrics:
 * - Null, undefined, or non-object responses fail.
 * - Missing or non-string planHash fails.
 * - Missing, non-object, or non-numeric measuredFacts fails.
 * - Missing or non-boolean readyForApproval fails.
 * - Transformation errors or schema conflicts fail.
 * - Non-COMPLETED status fails.
 */
export function evaluateDryRunResponse(res: any): DryRunEvaluation {
  if (!res || typeof res !== 'object' || Array.isArray(res)) {
    return {
      success: false,
      error: 'Unexpected response shape from dry-run endpoint: response was empty or malformed.',
    };
  }

  // 1. Status and readiness flags must be present and exact
  if (res.status !== 'COMPLETED') {
    const statusText = typeof res.status === 'string' ? res.status : 'UNKNOWN';
    return {
      success: false,
      error: `Dry run validation failed: status is '${statusText}' (expected 'COMPLETED'). Readiness check rejected approval.`,
    };
  }

  if (res.readyForApproval !== true) {
    return {
      success: false,
      error: 'Dry run validation rejected: readyForApproval is false or not certified.',
    };
  }

  // 2. Plan hash verification
  if (!res.planHash || typeof res.planHash !== 'string' || res.planHash.trim().length === 0) {
    return {
      success: false,
      error: 'Dry run rejected: missing or malformed planHash in response payload.',
    };
  }

  // 3. Strict measured facts & metrics inspection
  const facts = res.measuredFacts;
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) {
    return {
      success: false,
      error: 'Dry run rejected: missing or malformed measuredFacts in response payload.',
    };
  }

  const sampleTested = facts.sampleRecordsTested;
  const transformed = facts.recordsTransformed;
  const errors = facts.transformationErrors;
  const duration = facts.measuredDurationMs;

  if (typeof sampleTested !== 'number' || !Number.isFinite(sampleTested) || sampleTested < 0) {
    return {
      success: false,
      error: 'Dry run rejected: sampleRecordsTested metric is missing, invalid, or non-numeric.',
    };
  }

  if (typeof transformed !== 'number' || !Number.isFinite(transformed) || transformed < 0) {
    return {
      success: false,
      error: 'Dry run rejected: recordsTransformed metric is missing, invalid, or non-numeric.',
    };
  }

  if (typeof errors !== 'number' || !Number.isFinite(errors) || errors < 0) {
    return {
      success: false,
      error: 'Dry run rejected: transformationErrors metric is missing, invalid, or non-numeric.',
    };
  }

  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    return {
      success: false,
      error: 'Dry run rejected: measuredDurationMs metric is missing, invalid, or non-numeric.',
    };
  }

  // Check top-level numeric fields if present
  if (typeof res.transformationErrors !== 'number' || !Number.isFinite(res.transformationErrors)) {
    return {
      success: false,
      error: 'Dry run rejected: top-level transformationErrors is missing, invalid, or non-numeric.',
    };
  }

  if (!Array.isArray(res.potentialTypeConflicts)) {
    return {
      success: false,
      error: 'Dry run rejected: potentialTypeConflicts is missing or not an array.',
    };
  }

  // 4. Zero-defect invariants
  const errorCount = res.transformationErrors;
  const conflictCount = res.potentialTypeConflicts.length;

  if (errorCount > 0 || conflictCount > 0 || errors > 0) {
    return {
      success: false,
      error: `Dry run validation failed: ${errorCount || errors} transformation errors, ${conflictCount} schema conflicts detected. Readiness check rejected approval.`,
    };
  }

  return {
    success: true,
    error: null,
  };
}

export interface WizardStepGateState {
  isDemo: boolean;
  sourceConnId: string;
  targetConnId: string;
  sourceHandshakeSuccess: boolean;
  targetHandshakeSuccess: boolean;
  dryRunSuccess: boolean;
  isConfigModifiedSinceDryRun: boolean;
  planStatus?: string | null;
  hasMigrationRun: boolean;
  migrationRunStatus?: string | null;
  hasValidationRun: boolean;
}

export interface WizardStepGateResult {
  allowed: boolean;
  reason: string | null;
}

/**
 * Single source of truth for Wizard step progression across both Next Step and the top step indicator bar.
 * Moving backward is always permitted so operators can revisit earlier configuration; moving forward
 * enforces prerequisite verification, dry run, approval, run completion, and validation gates.
 */
export function canTransitionWizardStep(
  targetStep: number,
  currentStep: number,
  state: WizardStepGateState,
): WizardStepGateResult {
  if (!Number.isInteger(targetStep) || targetStep < 1 || targetStep > 14) {
    return { allowed: false, reason: 'Invalid wizard step' };
  }

  if (targetStep <= currentStep) {
    return { allowed: true, reason: null };
  }

  if (targetStep > 1 && !state.sourceConnId) {
    return { allowed: false, reason: 'Select a source connection in Step 1 before advancing' };
  }

  if (targetStep > 2 && !state.targetConnId) {
    return { allowed: false, reason: 'Select a target connection in Step 2 before advancing' };
  }

  if (targetStep > 3 && (!state.sourceHandshakeSuccess || !state.targetHandshakeSuccess)) {
    return {
      allowed: false,
      reason: 'Verify both source and target connections in Step 3 before advancing',
    };
  }

  if (targetStep > 10 && (!state.dryRunSuccess || state.isConfigModifiedSinceDryRun)) {
    return {
      allowed: false,
      reason: state.isConfigModifiedSinceDryRun
        ? 'Configuration changed since last dry run — re-run Step 10 before advancing'
        : 'Execute and pass pre-flight dry run in Step 10 before advancing',
    };
  }

  if (targetStep > 11 && !state.isDemo && state.planStatus !== 'APPROVED') {
    return {
      allowed: false,
      reason: 'Approve the migration plan version in Step 11 before advancing',
    };
  }

  if (
    targetStep > 12 &&
    !state.isDemo &&
    (!state.hasMigrationRun || state.migrationRunStatus !== 'COMPLETED')
  ) {
    return {
      allowed: false,
      reason:
        "Complete the migration run in Step 12 (status 'COMPLETED') before advancing to validation",
    };
  }

  if (targetStep > 13 && !state.isDemo && !state.hasValidationRun) {
    return {
      allowed: false,
      reason: 'Execute post-migration validation in Step 13 before advancing to reports',
    };
  }

  return { allowed: true, reason: null };
}
