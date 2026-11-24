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
 * Eliminates all false-success paths:
 * - Null, undefined, or non-object responses fail.
 * - Missing readyForApproval fails.
 * - Transformation errors or schema conflicts fail.
 * - Non-COMPLETED status fails.
 */
export function evaluateDryRunResponse(res: any): DryRunEvaluation {
  if (!res || typeof res !== 'object') {
    return {
      success: false,
      error: 'Unexpected response shape from dry-run endpoint: response was empty or malformed.',
    };
  }

  // Strict check on response properties
  const isCompleted = res.status === 'COMPLETED';
  const isReady = res.readyForApproval === true;
  const errorCount = typeof res.transformationErrors === 'number' ? res.transformationErrors : 0;
  const conflictCount = Array.isArray(res.potentialTypeConflicts) ? res.potentialTypeConflicts.length : 0;

  if (isCompleted && isReady && errorCount === 0 && conflictCount === 0) {
    return {
      success: true,
      error: null,
    };
  }

  return {
    success: false,
    error: `Dry run validation failed: ${errorCount} transformation errors, ${conflictCount} schema conflicts detected. Readiness check rejected approval.`,
  };
}
