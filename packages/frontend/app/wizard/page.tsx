'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import {
  Check,
  ArrowRight,
  ArrowLeft,
  ShieldCheck,
  Database,
  Layers,
  Sparkles,
  GitCompare,
  Eye,
  Settings,
  Play,
  Activity,
  FileCheck,
  Download,
  AlertTriangle,
  RefreshCw,
  Hash,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  Plus,
  Loader2,
} from 'lucide-react';
import { Badge } from '../../components/common/Badge';
import { PlanApprovalModal } from '../../components/wizard/PlanApprovalModal';
import { TransformPreviewDrawer } from '../../components/mappings/TransformPreviewDrawer';
import {
  MOCK_CONNECTIONS,
  MOCK_MONGO_SNAPSHOT,
  MOCK_POSTGRES_SNAPSHOT,
  MOCK_MAPPING_VERSIONS,
  MOCK_PLANS,
  MOCK_MIGRATION_RUNS,
  MOCK_VALIDATION_RUN,
} from '../../lib/mock-data';
import {
  DatabaseConnection,
  SchemaSnapshot,
  MappingVersion,
  MigrationPlan,
  MigrationRun,
  DryRunResult,
  MigrationBatch,
  DiscrepancyRecord,
} from '../../lib/types';
import { formatNumber, truncateHash } from '../../lib/utils';
import { apiClient, isDemoModeEnabled } from '../../lib/api-client';
import { resolvePlanVersionId, evaluateDryRunResponse } from '../../lib/wizard-utils';

const WIZARD_STEPS = [
  { id: 1, name: 'Source Select', desc: 'Select MongoDB database' },
  { id: 2, name: 'Target Select', desc: 'Select PostgreSQL database' },
  { id: 3, name: 'Handshake', desc: 'Verify connectivity' },
  { id: 4, name: 'Source Schema', desc: 'Discover BSON structures' },
  { id: 5, name: 'Target Schema', desc: 'Inspect SQL constraints' },
  { id: 6, name: 'AI Mapping', desc: 'Synthesize recommendations' },
  { id: 7, name: 'Mapping Review', desc: 'Configure transformations' },
  { id: 8, name: 'Sample Preview', desc: 'Test in-memory conversion' },
  { id: 9, name: 'Plan Config', desc: 'Set batch size & workers' },
  { id: 10, name: 'Dry Run', desc: 'Execute isolated dry-run' },
  { id: 11, name: 'Hash Approval', desc: 'Cryptographic SHA-256 sign' },
  { id: 12, name: 'Live Execution', desc: 'Stream batches & checkpoints' },
  { id: 13, name: 'Validation', desc: 'Reconcile 45-defect benchmark' },
  { id: 14, name: 'Export Reports', desc: 'Download CSV / HTML audit' },
];

interface ConfigSnapshot {
  sourceConnId: string;
  targetConnId: string;
  mappingVersionId: string;
  batchSize: number;
  concurrency: number;
  writeMode: string;
  planVersionId: string;
  planHash: string;
}

export default function MigrationWizardPage() {
  const isDemo = isDemoModeEnabled();

  // Wizard Navigation
  const [currentStep, setCurrentStep] = useState(1);

  // Authenticated Context (Requirement 1: Replace implicit "default" with authenticated IDs)
  const [workspaceId, setWorkspaceId] = useState<string>('default');
  const [projectId, setProjectId] = useState<string>('default');

  // Step 1 & 2: Connections
  const [connections, setConnections] = useState<DatabaseConnection[]>(isDemo ? MOCK_CONNECTIONS : []);
  const [sourceConnId, setSourceConnId] = useState<string>(isDemo ? 'conn-mongo-prod-01' : '');
  const [targetConnId, setTargetConnId] = useState<string>(isDemo ? 'conn-pg-prod-01' : '');

  // Step 4 & 5: Schema Snapshots
  const [sourceSnapshots, setSourceSnapshots] = useState<SchemaSnapshot[]>(isDemo ? [MOCK_MONGO_SNAPSHOT] : []);
  const [destSnapshots, setDestSnapshots] = useState<SchemaSnapshot[]>(isDemo ? [MOCK_POSTGRES_SNAPSHOT] : []);

  // Step 6 & 7: Mappings & AI suggestions
  const [mappings, setMappings] = useState<MappingVersion[]>(isDemo ? MOCK_MAPPING_VERSIONS : []);
  const [selectedMappingVersion, setSelectedMappingVersion] = useState<MappingVersion | null>(
    isDemo ? MOCK_MAPPING_VERSIONS[0] : null
  );
  const [mappingDslText, setMappingDslText] = useState<string>('');
  const [mappingValidationResult, setMappingValidationResult] = useState<{ valid: boolean; issues: any[] } | null>(null);
  const [isValidatingMapping, setIsValidatingMapping] = useState(false);
  const [isSavingMapping, setIsSavingMapping] = useState(false);
  const [mappingActionError, setMappingActionError] = useState<string | null>(null);

  // Step 3: Dual Connection Verification State
  const [sourceHandshake, setSourceHandshake] = useState<{ loading: boolean; tested: boolean; success: boolean; latencyMs?: number; message?: string } | null>(
    isDemo ? { loading: false, tested: true, success: true, latencyMs: 12, message: 'Verified MongoDB TLS ping' } : null
  );
  const [targetHandshake, setTargetHandshake] = useState<{ loading: boolean; tested: boolean; success: boolean; latencyMs?: number; message?: string } | null>(
    isDemo ? { loading: false, tested: true, success: true, latencyMs: 14, message: 'Verified PostgreSQL ping' } : null
  );
  const [isTestingHandshake, setIsTestingHandshake] = useState(false);

  // Step 6: AI Suggestions State
  const [aiSuggestions, setAiSuggestions] = useState<any | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Step 8: Preview State
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<{
    source: any;
    transformed: any;
    transformStepsApplied: { field: string; op: string; before: any; after: any }[];
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Step 9: Plan & Execution Configuration
  const [plans, setPlans] = useState<MigrationPlan[]>(isDemo ? MOCK_PLANS : []);
  const [plan, setPlan] = useState<MigrationPlan | null>(isDemo ? MOCK_PLANS[0] : null);
  const [batchSize, setBatchSize] = useState<number>(500);
  const [concurrency, setConcurrency] = useState<number>(4);
  const [writeMode, setWriteMode] = useState<'INSERT_ONLY' | 'UPSERT'>('UPSERT');

  // Loading & Persistence state
  const [isLoading, setIsLoading] = useState(!isDemo);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [isPersistingPlan, setIsPersistingPlan] = useState(false);
  const [planPersistError, setPlanPersistError] = useState<string | null>(null);

  // Step 10: Dry Run State
  const [dryRunRunning, setDryRunRunning] = useState(false);
  const [dryRunSuccess, setDryRunSuccess] = useState(false);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [dryRunDetails, setDryRunDetails] = useState<DryRunResult | null>(null);

  // Requirement 4: Lifecycle & Hash verification at dry-run
  const [configAtDryRun, setConfigAtDryRun] = useState<ConfigSnapshot | null>(null);

  // Step 11: Approval
  const [isApprovalOpen, setIsApprovalOpen] = useState(false);

  // Step 12: Live Execution State
  const [migrationRun, setMigrationRun] = useState<MigrationRun | null>(isDemo ? MOCK_MIGRATION_RUNS[0] : null);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runProgress, setRunProgress] = useState<any | null>(null);
  const [runBatches, setRunBatches] = useState<MigrationBatch[]>([]);

  // Step 13: Validation State
  const [validationRun, setValidationRun] = useState<any | null>(isDemo ? MOCK_VALIDATION_RUN : null);
  const [isValidating, setIsValidating] = useState(false);
  const [valError, setValError] = useState<string | null>(null);
  const [discrepancies, setDiscrepancies] = useState<DiscrepancyRecord[]>([]);
  const [validationChecks, setValidationChecks] = useState<any[]>([]);

  // Step 14: Reports Export State
  const [isGeneratingHtml, setIsGeneratingHtml] = useState(false);
  const [isGeneratingCsv, setIsGeneratingCsv] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportSuccessMessage, setReportSuccessMessage] = useState<string | null>(null);

  const nextStep = () => setCurrentStep((prev) => Math.min(prev + 1, 14));
  const prevStep = () => setCurrentStep((prev) => Math.max(prev - 1, 1));

  // Requirement 4: Invalidate plan version and dry run when execution configuration changes
  const invalidateDryRunAndPlanVersion = useCallback(() => {
    setDryRunSuccess(false);
    setDryRunDetails(null);
    setDryRunError(null);
    setConfigAtDryRun(null);
    setPlan((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        versionId: undefined,
        planHash: 'sha256:pending',
      };
    });
  }, []);

  // Step 3: Trigger real dual handshake verification probes
  const handleTestHandshake = async () => {
    if (!sourceConnId || !targetConnId) return;
    setIsTestingHandshake(true);
    setSourceHandshake({ loading: true, tested: false, success: false });
    setTargetHandshake({ loading: true, tested: false, success: false });
    try {
      const [sRes, tRes] = await Promise.allSettled([
        apiClient.testConnection(sourceConnId),
        apiClient.testConnection(targetConnId),
      ]);
      if (sRes.status === 'fulfilled') {
        setSourceHandshake({
          loading: false,
          tested: true,
          success: sRes.value.success,
          latencyMs: sRes.value.latencyMs,
          message: sRes.value.message,
        });
      } else {
        setSourceHandshake({
          loading: false,
          tested: true,
          success: false,
          message: sRes.reason?.message || 'Source connection probe failed',
        });
      }
      if (tRes.status === 'fulfilled') {
        setTargetHandshake({
          loading: false,
          tested: true,
          success: tRes.value.success,
          latencyMs: tRes.value.latencyMs,
          message: tRes.value.message,
        });
      } else {
        setTargetHandshake({
          loading: false,
          tested: true,
          success: false,
          message: tRes.reason?.message || 'Target connection probe failed',
        });
      }
    } finally {
      setIsTestingHandshake(false);
    }
  };

  useEffect(() => {
    if (currentStep === 3 && sourceConnId && targetConnId && (!sourceHandshake || !targetHandshake)) {
      handleTestHandshake();
    }
  }, [currentStep, sourceConnId, targetConnId]);

  // Sync mapping DSL text whenever selectedMappingVersion changes
  useEffect(() => {
    if (selectedMappingVersion) {
      const json = (selectedMappingVersion as any).mapping_json || (selectedMappingVersion as any).mappingJson || selectedMappingVersion.objects || {};
      setMappingDslText(JSON.stringify(json, null, 2));
    }
  }, [selectedMappingVersion]);

  // Load real workspace, projects, connections, mappings, and plans on mount
  const loadResources = async () => {
    setIsLoading(true);
    setLoadingError(null);

    let resolvedWs = 'default';
    let resolvedProj = 'default';

    if (!isDemo) {
      try {
        const me: any = await apiClient.getCurrentUser();
        if (me?.workspaces && me.workspaces.length > 0) {
          resolvedWs = me.workspaces[0].workspace_id || me.workspaces[0].id || 'default';
          setWorkspaceId(resolvedWs);

          const projectList = await apiClient.getProjects(resolvedWs);
          if (Array.isArray(projectList) && projectList.length > 0) {
            resolvedProj = projectList[0].id;
          } else {
            const createdProj = await apiClient.createProject(
              resolvedWs,
              'Migration Project',
              'Workspace project for migration plans'
            );
            resolvedProj = createdProj.id;
          }
          setProjectId(resolvedProj);
        }
      } catch (err: any) {
        console.warn('Could not resolve authenticated user workspace/project:', err);
      }
    }

    try {
      const [connsRes, plansRes, mapsRes] = await Promise.allSettled([
        apiClient.getConnections(resolvedWs),
        apiClient.getPlans(resolvedProj),
        apiClient.getMappings(resolvedProj),
      ]);

      // Requirement 1: Surface individual API failures; do not silently convert rejected requests to empty states
      const failures: string[] = [];
      if (connsRes.status === 'rejected') failures.push(`Connections: ${connsRes.reason?.message || connsRes.reason}`);
      if (plansRes.status === 'rejected') failures.push(`Plans: ${plansRes.reason?.message || plansRes.reason}`);
      if (mapsRes.status === 'rejected') failures.push(`Mappings: ${mapsRes.reason?.message || mapsRes.reason}`);

      if (failures.length > 0 && !isDemo) {
        setLoadingError(`Backend resource loading failed: ${failures.join(' | ')}`);
      }

      const loadedConns = connsRes.status === 'fulfilled' ? connsRes.value : [];
      const loadedPlans = plansRes.status === 'fulfilled' ? plansRes.value : [];
      const loadedMaps = mapsRes.status === 'fulfilled' ? mapsRes.value : [];

      if (loadedConns.length > 0) {
        setConnections(loadedConns);
        const mongo = loadedConns.find((c) => c.engine === 'MONGODB');
        const pg = loadedConns.find((c) => c.engine === 'POSTGRESQL');
        if (mongo && !sourceConnId) setSourceConnId(mongo.id);
        if (pg && !targetConnId) setTargetConnId(pg.id);
      } else if (isDemo) {
        setConnections(MOCK_CONNECTIONS);
        if (!sourceConnId) setSourceConnId('conn-mongo-prod-01');
        if (!targetConnId) setTargetConnId('conn-pg-prod-01');
      }

      if (loadedPlans.length > 0) {
        setPlans(loadedPlans);
        if (!plan) setPlan(loadedPlans[0]);
      } else if (isDemo) {
        setPlans(MOCK_PLANS);
        if (!plan) setPlan(MOCK_PLANS[0]);
      }

      if (loadedMaps.length > 0) {
        setMappings(loadedMaps);
        if (!selectedMappingVersion) setSelectedMappingVersion(loadedMaps[0]);
      } else if (isDemo) {
        setMappings(MOCK_MAPPING_VERSIONS);
        if (!selectedMappingVersion) setSelectedMappingVersion(MOCK_MAPPING_VERSIONS[0]);
      }
    } catch (err: any) {
      if (isDemo) {
        setConnections(MOCK_CONNECTIONS);
        setPlans(MOCK_PLANS);
        setMappings(MOCK_MAPPING_VERSIONS);
      } else {
        setLoadingError(err?.message || 'Failed to load backend migration resources.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadResources();
  }, []);

  // Load snapshots when source connection is selected
  useEffect(() => {
    if (!sourceConnId) return;
    apiClient
      .getSchemaSnapshots(sourceConnId)
      .then((snaps) => {
        if (snaps && snaps.length > 0) {
          setSourceSnapshots(snaps);
        } else if (isDemo) {
          setSourceSnapshots([MOCK_MONGO_SNAPSHOT]);
        }
      })
      .catch(() => {
        if (isDemo) setSourceSnapshots([MOCK_MONGO_SNAPSHOT]);
      });
  }, [sourceConnId, isDemo]);

  // Load snapshots when target connection is selected
  useEffect(() => {
    if (!targetConnId) return;
    apiClient
      .getSchemaSnapshots(targetConnId)
      .then((snaps) => {
        if (snaps && snaps.length > 0) {
          setDestSnapshots(snaps);
        } else if (isDemo) {
          setDestSnapshots([MOCK_POSTGRES_SNAPSHOT]);
        }
      })
      .catch(() => {
        if (isDemo) setDestSnapshots([MOCK_POSTGRES_SNAPSHOT]);
      });
  }, [targetConnId, isDemo]);

  /**
   * Requirement 2: Ensure the Wizard creates, retrieves, and selects real mapping versions.
   */
  const ensureRealMappingVersion = async (planId: string): Promise<MappingVersion | null> => {
    if (selectedMappingVersion?.id && !selectedMappingVersion.id.startsWith('map-ver-001')) {
      return selectedMappingVersion;
    }

    setIsSavingMapping(true);
    setMappingActionError(null);
    try {
      const defaultDsl = {
        version: 1,
        objects: [
          {
            source: { collection: 'customers' },
            destination: { schema: 'public', table: 'customers' },
            identity: { sourceKey: '_id', destinationKey: 'id', strategy: 'PRESERVE_AS_TEXT' },
            fields: [
              { sourcePath: 'name', destinationPath: 'name', transform: { op: 'TRIM_STRING' } },
              { sourcePath: 'email', destinationPath: 'email', transform: { op: 'LOWERCASE' } },
              { sourcePath: 'createdAt', destinationPath: 'created_at', transform: { op: 'PARSE_TIMESTAMP' } },
              { sourcePath: 'metadata', destinationPath: 'metadata', transform: { op: 'TO_JSONB' } },
            ],
          },
        ],
      };

      const created = await apiClient.createMappingVersion(planId, defaultDsl);
      setSelectedMappingVersion(created);
      setMappings((prev) => [created, ...prev.filter((m) => m.id !== created.id)]);
      setMappingDslText(JSON.stringify((created as any).mapping_json || (created as any).mappingJson || defaultDsl, null, 2));
      return created;
    } catch (err: any) {
      setMappingActionError(err?.message || 'Failed to create real backend mapping version.');
      return null;
    } finally {
      setIsSavingMapping(false);
    }
  };

  /**
   * Requirement 3: Create or retrieve a persisted migration plan version before dry-run execution.
   */
  const ensurePersistedPlanVersion = async (): Promise<string | null> => {
    // If plan already has a valid resolved version ID, return it
    const existingVersionId = resolvePlanVersionId(plan);
    if (existingVersionId) {
      return existingVersionId;
    }

    setIsPersistingPlan(true);
    setPlanPersistError(null);

    try {
      let currentPlanId = plan?.id;

      // If no persisted plan container exists yet, create one
      if (!currentPlanId) {
        const createdPlan = await apiClient.createPlan(projectId, 'E-Commerce Modernization Plan');
        currentPlanId = createdPlan.id;
        setPlan(createdPlan);
      }

      // Requirement 2: Ensure a real persisted mapping version exists
      let activeMapping = selectedMappingVersion;
      if (!activeMapping?.id || (!isDemo && activeMapping.id === 'map-ver-001')) {
        activeMapping = await ensureRealMappingVersion(currentPlanId);
      }

      if (!activeMapping?.id) {
        throw new Error('A persisted mapping version is required before creating a plan version.');
      }

      // Persist a new migration plan version
      const versionDto = {
        sourceConnectionId: sourceConnId || connections.find((c) => c.engine === 'MONGODB')?.id || '',
        destinationConnectionId: targetConnId || connections.find((c) => c.engine === 'POSTGRESQL')?.id || '',
        sourceSchemaSnapshotId: sourceSnapshots[0]?.id,
        destinationSchemaSnapshotId: destSnapshots[0]?.id,
        mappingVersionId: activeMapping.id,
        scope: { tables: ['customers'] },
        executionConfig: {
          batchSize,
          concurrency,
          writeMode,
        },
        validationProfile: {
          countCheck: true,
          missingRecordCheck: true,
          extraRecordCheck: true,
          duplicateCheck: true,
          contentHashCheck: true,
          fieldValidation: true,
          attachmentCheck: true,
          relationshipCheck: true,
          metadataCheck: true,
        },
      };

      const createdVersion = await apiClient.createPlanVersion(currentPlanId, versionDto);
      const newVersionId = createdVersion.id;

      if (!newVersionId) {
        throw new Error('Backend failed to return a valid plan version ID.');
      }

      const updatedPlan: MigrationPlan = {
        ...(plan || {
          id: currentPlanId,
          name: 'E-Commerce Modernization Plan',
          status: 'DRAFT',
          sourceConnectionId: versionDto.sourceConnectionId,
          destinationConnectionId: versionDto.destinationConnectionId,
          mappingVersionId: activeMapping.id,
          batchSize,
          concurrency,
          writeMode: 'UPSERT_ON_KEY' as const,
          planHash: 'sha256:pending',
          createdAt: new Date().toISOString(),
        }),
        mappingVersionId: activeMapping.id,
        versionId: newVersionId,
        planHash: createdVersion.plan_hash || createdVersion.planHash || 'sha256:pending',
        versions: [
          {
            id: newVersionId,
            version: createdVersion.version || 1,
            planHash: createdVersion.plan_hash || createdVersion.planHash || 'sha256:pending',
            status: createdVersion.status || 'DRAFT',
          },
        ],
      };

      setPlan(updatedPlan);
      return newVersionId;
    } catch (err: any) {
      const errMsg = err?.message || 'Failed to create and persist migration plan version.';
      setPlanPersistError(errMsg);
      return null;
    } finally {
      setIsPersistingPlan(false);
    }
  };

  /**
   * Step 6: Call AI mapping suggestion API
   */
  const handleGetAiSuggestions = async () => {
    let mappingId = selectedMappingVersion?.id;
    if (!mappingId && plan?.id) {
      const created = await ensureRealMappingVersion(plan.id);
      mappingId = created?.id;
    }

    if (!mappingId) {
      setAiError('A valid mapping version is required before calling AI suggestions.');
      return;
    }

    setAiLoading(true);
    setAiError(null);
    try {
      const res: any = await apiClient.getAiMappingSuggestions(mappingId, {
        sourceSnapshotId: sourceSnapshots[0]?.id || (isDemo ? 'snap-mongo-001' : undefined),
        targetSnapshotId: destSnapshots[0]?.id || (isDemo ? 'snap-pg-001' : undefined),
        sourceObject: 'customers',
        destinationObject: 'customers',
      });
      setAiSuggestions(res?.data || res);
    } catch (err: any) {
      setAiError(err?.message || 'Failed to fetch AI mapping suggestions.');
    } finally {
      setAiLoading(false);
    }
  };

  /**
   * Step 7: Validate mapping DSL and save edits
   */
  const handleValidateMapping = async () => {
    if (!selectedMappingVersion?.id) {
      setMappingActionError('Please select or create a mapping version to validate.');
      return;
    }
    setIsValidatingMapping(true);
    setMappingActionError(null);
    try {
      const res = await apiClient.validateMapping(selectedMappingVersion.id);
      setMappingValidationResult(res);
    } catch (err: any) {
      setMappingActionError(err?.message || 'Mapping DSL validation failed.');
    } finally {
      setIsValidatingMapping(false);
    }
  };

  const handleSaveMappingEdits = async () => {
    if (!plan?.id) {
      setMappingActionError('A migration plan container must exist before saving mapping versions.');
      return;
    }

    let parsedDsl: any;
    try {
      parsedDsl = JSON.parse(mappingDslText);
    } catch {
      setMappingActionError('Invalid JSON: Please correct the JSON syntax before saving.');
      return;
    }

    setIsSavingMapping(true);
    setMappingActionError(null);
    try {
      const created = await apiClient.createMappingVersion(plan.id, parsedDsl);
      setSelectedMappingVersion(created);
      setMappings((prev) => [created, ...prev.filter((m) => m.id !== created.id)]);
      setMappingValidationResult({ valid: true, issues: [] });
      invalidateDryRunAndPlanVersion();
    } catch (err: any) {
      setMappingActionError(err?.message || 'Failed to save mapping version in backend.');
    } finally {
      setIsSavingMapping(false);
    }
  };

  /**
   * Step 8: Call transformation preview endpoint with dynamic sample record & steps derivation
   */
  const handleFetchPreview = async () => {
    if (!selectedMappingVersion?.id) {
      setPreviewError('No mapping version selected for transformation preview.');
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      // 1. Require genuine sample record from source snapshot in live mode
      const snap: any = sourceSnapshots[0];
      const snapshotSample =
        snap?.samples?.customers?.[0] ||
        snap?.snapshot_json?.samples?.customers?.[0] ||
        snap?.collections?.[0]?.sampleDocuments?.[0];

      let sampleDoc = snapshotSample;
      if (!sampleDoc) {
        if (isDemoModeEnabled()) {
          sampleDoc = {
            _id: '507f1f77bcf86cd799439011',
            name: '   Acme Enterprise LLC   ',
            email: 'CONTACT@ACME.COM',
            createdAt: '2026-11-19T20:00:00.000Z',
            metadata: { street: '100 Market St', city: 'San Francisco', state: 'CA' },
          };
        } else {
          setPreviewError(
            'Cannot preview transformations: no sample document available in source schema snapshot. Capture a schema snapshot containing sample documents or enable Demo Mode.',
          );
          setPreviewLoading(false);
          return;
        }
      }

      const res: any = await apiClient.previewTransform(selectedMappingVersion.id, sampleDoc);
      const previewItem = Array.isArray(res?.preview) ? res.preview[0] : (res?.preview || res);
      const transformedRecord = previewItem?.transformedRecord || previewItem?.transformed || {};

      // 2. Derive applied transform steps dynamically from mapping DSL
      let parsedDsl: any = null;
      try {
        parsedDsl = JSON.parse(mappingDslText);
      } catch {
        parsedDsl = (selectedMappingVersion as any)?.mapping_json || selectedMappingVersion;
      }

      const objects = Array.isArray(parsedDsl?.objects)
        ? parsedDsl.objects
        : (parsedDsl?.source ? [parsedDsl] : []);

      const dynamicSteps: Array<{ field: string; op: string; before: any; after: any }> = [];
      for (const obj of objects) {
        for (const f of (obj.fields || [])) {
          const srcVal = sampleDoc[f.sourcePath];
          const destVal = transformedRecord[f.destinationPath];
          dynamicSteps.push({
            field: `${f.sourcePath} → ${f.destinationPath}`,
            op: f.transform?.op || 'DIRECT_COPY',
            before: srcVal !== undefined ? (typeof srcVal === 'object' ? JSON.stringify(srcVal) : String(srcVal)) : 'null',
            after: destVal !== undefined ? (typeof destVal === 'object' ? JSON.stringify(destVal) : String(destVal)) : 'null',
          });
        }
      }

      const formattedPreview = {
        source: previewItem?.sourceRecord || sampleDoc,
        transformed: transformedRecord,
        transformStepsApplied: dynamicSteps.length > 0 ? dynamicSteps : [
          { field: 'record', op: 'MAPPING_DSL', before: 'Input document', after: 'Transformed record' },
        ],
      };

      setPreviewData(formattedPreview);
      setIsPreviewOpen(true);
    } catch (err: any) {
      setPreviewError(err?.message || 'Failed to preview transformation from backend.');
    } finally {
      setPreviewLoading(false);
    }
  };

  /**
   * Step 10: Trigger dry-run
   */
  const handleTriggerDryRun = async () => {
    setDryRunRunning(true);
    setDryRunSuccess(false);
    setDryRunError(null);
    setDryRunDetails(null);

    // Requirement 3: Ensure valid persisted version exists before executing dry-run
    let versionId = resolvePlanVersionId(plan);
    if (!versionId) {
      versionId = await ensurePersistedPlanVersion();
    }

    if (!versionId) {
      setDryRunError(
        'Dry run execution aborted: No valid persisted plan version ID found. Please persist plan version before executing dry run.'
      );
      setDryRunRunning(false);
      setDryRunSuccess(false);
      return;
    }

    try {
      // Connect to real backend API dry-run endpoint: POST /plan-versions/:versionId/dry-runs
      const res = await apiClient.startDryRun(versionId);
      // Requirement 5: Strict evaluation rejecting missing or malformed metrics
      const evalResult = evaluateDryRunResponse(res);
      setDryRunDetails(res);

      if (evalResult.success) {
        setDryRunSuccess(true);
        setDryRunError(null);
        // Requirement 4: Snapshot configuration at dry-run
        setConfigAtDryRun({
          sourceConnId,
          targetConnId,
          mappingVersionId: selectedMappingVersion?.id || '',
          batchSize,
          concurrency,
          writeMode,
          planVersionId: versionId,
          planHash: res.planHash || plan?.planHash || '',
        });
      } else {
        setDryRunSuccess(false);
        setDryRunError(evalResult.error);
        setConfigAtDryRun(null);
      }
    } catch (err: any) {
      setDryRunSuccess(false);
      setDryRunDetails(null);
      setConfigAtDryRun(null);
      setDryRunError(err?.message || 'Dry run execution failed: backend service unavailable or returned an unhandled error.');
    } finally {
      setDryRunRunning(false);
    }
  };

  /**
   * Requirement 4: Verify dry-run hash matches approved version & configuration has not changed
   */
  const isConfigModifiedSinceDryRun = useMemo(() => {
    if (!configAtDryRun) return true;
    return (
      configAtDryRun.sourceConnId !== sourceConnId ||
      configAtDryRun.targetConnId !== targetConnId ||
      configAtDryRun.mappingVersionId !== (selectedMappingVersion?.id || '') ||
      configAtDryRun.batchSize !== batchSize ||
      configAtDryRun.concurrency !== concurrency ||
      configAtDryRun.writeMode !== writeMode ||
      (plan?.planHash && configAtDryRun.planHash !== plan.planHash)
    );
  }, [configAtDryRun, sourceConnId, targetConnId, selectedMappingVersion, batchSize, concurrency, writeMode, plan?.planHash]);

  const handlePlanApproved = (approvedPlan: MigrationPlan) => {
    setPlan(approvedPlan);
    nextStep();
  };

  /**
   * Step 12: Start live migration run and stream progress
   */
  const handleStartMigrationRun = async () => {
    const versionId = resolvePlanVersionId(plan);
    if (!versionId) {
      setRunError('Cannot start migration run: no approved plan version found.');
      return;
    }

    setIsStartingRun(true);
    setRunError(null);
    try {
      const res = await apiClient.startMigrationRun(versionId);
      const runId = res.runId || (res as any).id;
      const fullRun = await apiClient.getMigrationRun(runId);
      setMigrationRun(fullRun);

      const progress = await apiClient.getMigrationProgress(runId);
      setRunProgress(progress);

      const batches = await apiClient.getMigrationBatches(runId);
      setRunBatches(Array.isArray(batches) ? batches : []);
    } catch (err: any) {
      setRunError(err?.message || 'Failed to start migration run in backend.');
    } finally {
      setIsStartingRun(false);
    }
  };

  // Poll progress when run is active
  useEffect(() => {
    if (!migrationRun?.id) return;
    const interval = setInterval(async () => {
      try {
        const progress = await apiClient.getMigrationProgress(migrationRun.id);
        setRunProgress(progress);
        const batches = await apiClient.getMigrationBatches(migrationRun.id);
        setRunBatches(Array.isArray(batches) ? batches : []);

        if (progress?.status) {
          setMigrationRun((prev) => (prev ? { ...prev, status: progress.status as MigrationRun['status'] } : prev));
        }

        if (
          progress.status === 'COMPLETED' ||
          progress.status === 'MIGRATED' ||
          progress.status === 'VALIDATED' ||
          progress.status === 'FAILED' ||
          progress.status === 'CANCELLED'
        ) {
          clearInterval(interval);
        }
      } catch {
        // Polling catch
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [migrationRun?.id]);

  /**
   * Step 13: Trigger validation and fetch discrepancies
   */
  const handleTriggerValidation = async () => {
    const runId = migrationRun?.id;
    if (!runId) {
      setValError('Cannot trigger validation: no completed migration run available.');
      return;
    }

    setIsValidating(true);
    setValError(null);
    try {
      const val = await apiClient.triggerValidation(runId);
      const valId = val.id || (val as any).validationRunId;
      setValidationRun(val);

      const discList = await apiClient.getDiscrepancies(valId);
      setDiscrepancies(Array.isArray(discList) ? discList : []);

      const checks = await apiClient.getValidationChecks(valId);
      setValidationChecks(Array.isArray(checks) ? checks : []);
    } catch (err: any) {
      setValError(err?.message || 'Failed to trigger validation in backend.');
    } finally {
      setIsValidating(false);
    }
  };

  /**
   * Step 14: Generate and download HTML/CSV reports
   */
  const handleDownloadReport = async (format: 'HTML' | 'CSV') => {
    const valId = validationRun?.id || (isDemo ? 'val-default' : '');
    if (!valId) {
      setReportError('Cannot generate report: no completed validation run available in this session.');
      return;
    }
    if (format === 'HTML') setIsGeneratingHtml(true);
    if (format === 'CSV') setIsGeneratingCsv(true);
    setReportError(null);
    setReportSuccessMessage(null);

    try {
      const report: any = await apiClient.generateReport(valId, format === 'HTML' ? 'EXECUTIVE' : 'DETAILED', format);
      const reportId = report?.id || report?.reportId;
      const content = await apiClient.downloadReport(reportId);

      // Trigger browser download
      const mime = format === 'CSV' ? 'text/csv' : 'text/html';
      const blob = new Blob([content], { type: mime });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `migrationguard-report-${valId}.${format.toLowerCase()}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      setReportSuccessMessage(`Successfully generated and downloaded ${format} report.`);
    } catch (err: any) {
      setReportError(err?.message || `Failed to download ${format} report from backend.`);
    } finally {
      if (format === 'HTML') setIsGeneratingHtml(false);
      if (format === 'CSV') setIsGeneratingCsv(false);
    }
  };

  const sourceConnections = connections.filter((c) => c.engine === 'MONGODB');
  const targetConnections = connections.filter((c) => c.engine === 'POSTGRESQL');
  const selectedSource = connections.find((c) => c.id === sourceConnId);
  const selectedTarget = connections.find((c) => c.id === targetConnId);
  const resolvedVersionId = resolvePlanVersionId(plan);

  return (
    <div className="space-y-6">
      {/* Wizard Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-infra-heading tracking-tight flex items-center gap-2">
            <span>Guided 14-Step Migration Wizard</span>
            {isDemo ? (
              <span className="px-2 py-0.5 rounded text-xs bg-amber-500/10 text-amber-400 border border-amber-500/20 font-mono">
                [DEMO MODE: Synthetic Fixtures Active]
              </span>
            ) : (
              <span className="px-2 py-0.5 rounded text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                [LIVE PRODUCTION MODE]
              </span>
            )}
          </h1>
          <p className="text-xs text-infra-muted mt-1 font-mono">
            Explicit Scope: Workspace [{workspaceId}] • Project [{projectId}]
          </p>
        </div>

        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="text-infra-muted">Current Stage:</span>
          <span className="text-emerald-400 font-bold">Step {currentStep} of 14</span>
        </div>
      </div>

      {/* Global Resource Loading Error */}
      {loadingError && (
        <div className="p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs font-mono text-rose-300 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle size={16} className="text-rose-400 shrink-0" />
            <span>{loadingError}</span>
          </div>
          <button
            onClick={loadResources}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 transition-colors"
          >
            <RefreshCw size={12} />
            <span>Retry</span>
          </button>
        </div>
      )}

      {/* Progress Step Indicator Bar */}
      <div className="p-4 rounded-xl bg-infra-card border border-infra-border overflow-x-auto">
        <div className="flex items-center justify-between min-w-[900px] gap-2">
          {WIZARD_STEPS.map((s) => {
            const isCompleted = s.id < currentStep;
            const isCurrent = s.id === currentStep;

            return (
              <button
                key={s.id}
                onClick={() => setCurrentStep(s.id)}
                className={`flex flex-col items-center gap-1 group focus:outline-none transition-all ${
                  isCurrent
                    ? 'text-emerald-400 font-bold'
                    : isCompleted
                    ? 'text-infra-text'
                    : 'text-infra-muted/60'
                }`}
              >
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-mono border transition-all ${
                    isCurrent
                      ? 'bg-emerald-500 text-infra-base border-emerald-400 font-bold ring-2 ring-emerald-500/30'
                      : isCompleted
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      : 'bg-infra-surface border-infra-border text-infra-muted'
                  }`}
                >
                  {isCompleted ? <Check size={13} /> : s.id}
                </div>
                <span className="text-[10px] font-mono whitespace-nowrap">{s.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Step Content Box */}
      <div className="p-6 rounded-xl bg-infra-card border border-infra-border min-h-[440px] flex flex-col justify-between">
        {/* Step 1: Source Select */}
        {currentStep === 1 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <Database size={16} className="text-emerald-400" />
              <span>Step 1: Select Source MongoDB Database Profile</span>
            </h3>
            <p className="text-xs text-infra-muted">
              Choose the source database connection profile containing documents to migrate.
            </p>

            {sourceConnections.length > 0 ? (
              <div className="grid grid-cols-2 gap-4 pt-2">
                {sourceConnections.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => {
                      setSourceConnId(c.id);
                      invalidateDryRunAndPlanVersion();
                    }}
                    className={`p-4 rounded-xl border cursor-pointer transition-all ${
                      sourceConnId === c.id
                        ? 'bg-emerald-500/10 border-emerald-500 text-emerald-300 ring-1 ring-emerald-500'
                        : 'bg-infra-surface border-infra-border text-infra-text hover:border-infra-borderHover'
                    }`}
                  >
                    <div className="flex justify-between items-center mb-2">
                      <span className="font-bold text-xs font-mono">{c.name}</span>
                      <Badge variant="emerald" size="sm">v{c.credentialVersion || 1}</Badge>
                    </div>
                    <p className="text-xs font-mono text-infra-muted">
                      {c.config.host || 'cluster.internal'}:{c.config.port || 27017}/{c.config.database || 'appdb'}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center rounded-xl bg-infra-surface border border-dashed border-infra-border space-y-3">
                <Database size={28} className="mx-auto text-infra-muted/60" />
                <p className="text-xs text-infra-muted">No MongoDB source connections found in active workspace.</p>
                <Link
                  href="/connections"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-semibold bg-emerald-500 hover:bg-emerald-400 text-infra-base transition-colors"
                >
                  <Plus size={13} />
                  <span>Register Source Connection</span>
                </Link>
              </div>
            )}
          </div>
        )}

        {/* Step 2: Target Select */}
        {currentStep === 2 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <Database size={16} className="text-sky-400" />
              <span>Step 2: Select Destination PostgreSQL Database Profile</span>
            </h3>
            <p className="text-xs text-infra-muted">
              Choose the target relational database where typed records and relations will be written.
            </p>

            {targetConnections.length > 0 ? (
              <div className="grid grid-cols-2 gap-4 pt-2">
                {targetConnections.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => {
                      setTargetConnId(c.id);
                      invalidateDryRunAndPlanVersion();
                    }}
                    className={`p-4 rounded-xl border cursor-pointer transition-all ${
                      targetConnId === c.id
                        ? 'bg-sky-500/10 border-sky-500 text-sky-300 ring-1 ring-sky-500'
                        : 'bg-infra-surface border-infra-border text-infra-text hover:border-infra-borderHover'
                    }`}
                  >
                    <div className="flex justify-between items-center mb-2">
                      <span className="font-bold text-xs font-mono">{c.name}</span>
                      <Badge variant="sky" size="sm">v{c.credentialVersion || 1}</Badge>
                    </div>
                    <p className="text-xs font-mono text-infra-muted">
                      {c.config.host || 'postgres.internal'}:{c.config.port || 5432}/{c.config.database || 'migrationguard_dest'} (schema: {c.config.schema || 'public'})
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center rounded-xl bg-infra-surface border border-dashed border-infra-border space-y-3">
                <Database size={28} className="mx-auto text-infra-muted/60" />
                <p className="text-xs text-infra-muted">No PostgreSQL destination connections found in active workspace.</p>
                <Link
                  href="/connections"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-semibold bg-sky-500 hover:bg-sky-400 text-infra-base transition-colors"
                >
                  <Plus size={13} />
                  <span>Register Target Connection</span>
                </Link>
              </div>
            )}
          </div>
        )}

        {/* Step 3: Handshake */}
        {currentStep === 3 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
                  <ShieldCheck size={16} className="text-emerald-400" />
                  <span>Step 3: Dual Connection Verification & Latency Handshake</span>
                </h3>
                <p className="text-xs text-infra-muted mt-0.5">
                  Execute live bidirectional ping and protocol handshake to verify network access and TLS credentials.
                </p>
              </div>
              <button
                onClick={handleTestHandshake}
                disabled={isTestingHandshake}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-semibold bg-infra-surface border border-infra-border hover:bg-infra-cardHover text-infra-text transition-colors"
              >
                <RefreshCw size={12} className={isTestingHandshake ? 'animate-spin' : ''} />
                <span>{isTestingHandshake ? 'Testing Handshake...' : 'Retest Handshake'}</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Source Handshake */}
              <div
                className={`p-4 rounded-xl bg-infra-surface border text-xs font-mono space-y-2 transition-all ${
                  isTestingHandshake
                    ? 'border-infra-border opacity-70'
                    : sourceHandshake?.success
                    ? 'border-emerald-500/40 bg-emerald-500/5'
                    : sourceHandshake?.tested
                    ? 'border-red-500/40 bg-red-500/5'
                    : 'border-infra-border'
                }`}
              >
                <div className="flex justify-between items-center">
                  <span className="text-emerald-400 font-bold block truncate">
                    Source: {selectedSource?.name || sourceConnId || 'MongoDB Source'}
                  </span>
                  {sourceHandshake?.tested && (
                    <Badge variant={sourceHandshake.success ? 'emerald' : 'rose'} size="sm">
                      {sourceHandshake.success ? 'Verified' : 'Failed'}
                    </Badge>
                  )}
                </div>
                {isTestingHandshake ? (
                  <p className="text-infra-muted animate-pulse">Pinging MongoDB cluster and validating TLS...</p>
                ) : sourceHandshake?.tested ? (
                  <>
                    <p className={sourceHandshake.success ? 'text-emerald-300' : 'text-red-400 font-semibold'}>
                      Status: {sourceHandshake.success ? '200 OK • Read/Extract Authorized' : 'Connection Failed'}
                    </p>
                    <p className="text-infra-muted">
                      Latency: <span className="text-infra-text font-bold">{sourceHandshake.latencyMs ?? 0}ms</span> • {sourceHandshake.message || 'TLS Handshake Verified'}
                    </p>
                  </>
                ) : (
                  <p className="text-infra-muted">Awaiting handshake probe...</p>
                )}
              </div>

              {/* Destination Handshake */}
              <div
                className={`p-4 rounded-xl bg-infra-surface border text-xs font-mono space-y-2 transition-all ${
                  isTestingHandshake
                    ? 'border-infra-border opacity-70'
                    : targetHandshake?.success
                    ? 'border-sky-500/40 bg-sky-500/5'
                    : targetHandshake?.tested
                    ? 'border-red-500/40 bg-red-500/5'
                    : 'border-infra-border'
                }`}
              >
                <div className="flex justify-between items-center">
                  <span className="text-sky-400 font-bold block truncate">
                    Destination: {selectedTarget?.name || targetConnId || 'PostgreSQL Destination'}
                  </span>
                  {targetHandshake?.tested && (
                    <Badge variant={targetHandshake.success ? 'sky' : 'rose'} size="sm">
                      {targetHandshake.success ? 'Verified' : 'Failed'}
                    </Badge>
                  )}
                </div>
                {isTestingHandshake ? (
                  <p className="text-infra-muted animate-pulse">Testing TCP socket and relational schema permissions...</p>
                ) : targetHandshake?.tested ? (
                  <>
                    <p className={targetHandshake.success ? 'text-sky-300' : 'text-red-400 font-semibold'}>
                      Status: {targetHandshake.success ? '200 OK • Upsert/DDL Permissions Active' : 'Connection Failed'}
                    </p>
                    <p className="text-infra-muted">
                      Latency: <span className="text-infra-text font-bold">{targetHandshake.latencyMs ?? 0}ms</span> • {targetHandshake.message || 'Relational Schema Verified'}
                    </p>
                  </>
                ) : (
                  <p className="text-infra-muted">Awaiting handshake probe...</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Step 4: Source Schema */}
        {currentStep === 4 && (() => {
          const snapshot = sourceSnapshots[0];
          const collections = snapshot?.collections || (snapshot as any)?.snapshot_json?.collections || [];
          return (
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
                <Layers size={16} className="text-emerald-400" />
                <span>
                  Step 4: Source MongoDB Schema Discovery {snapshot ? `(${snapshot.id})` : ''}
                </span>
              </h3>
              {collections.length > 0 ? (
                <>
                  <p className="text-xs text-infra-muted">
                    Discovered {collections.length} collection{collections.length > 1 ? 's' : ''} in snapshot captured on {snapshot.capturedAt ? new Date(snapshot.capturedAt).toLocaleDateString() : 'recent run'}.
                  </p>
                  <div className="space-y-3 pt-1">
                    {collections.map((col: any, idx: number) => (
                      <div key={idx} className="p-3.5 rounded-lg bg-infra-surface border border-infra-border text-xs font-mono space-y-1.5">
                        <div className="flex justify-between items-center">
                          <span className="font-bold text-emerald-400">Collection: {col.name}</span>
                          <span className="text-infra-muted">
                            {formatNumber(col.documentCount || col.count || 0)} documents
                          </span>
                        </div>
                        {Array.isArray(col.fields) && col.fields.length > 0 ? (
                          <div className="text-[11px] text-infra-muted">
                            <span className="text-infra-text">Fields: </span>
                            {col.fields.map((f: any) => typeof f === 'string' ? f : f.name).join(', ')}
                          </div>
                        ) : (
                          <div className="text-[11px] text-infra-muted">
                            Embedded BSON structures and dynamic attributes identified.
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="p-6 rounded-xl bg-infra-surface border border-dashed border-infra-border space-y-2 text-center">
                  <Database size={24} className="mx-auto text-amber-400" />
                  <p className="text-xs font-mono text-infra-text font-bold">No Persisted Source Snapshot Available</p>
                  <p className="text-[11px] text-infra-muted max-w-md mx-auto">
                    No schema snapshot was found for source connection {selectedSource?.name || sourceConnId}. Live collection discovery will run during Dry Run (Step 10).
                  </p>
                </div>
              )}
            </div>
          );
        })()}

        {/* Step 5: Target Schema */}
        {currentStep === 5 && (() => {
          const snapshot = destSnapshots[0];
          const tables = snapshot?.tables || (snapshot as any)?.snapshot_json?.tables || [];
          return (
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
                <Layers size={16} className="text-sky-400" />
                <span>
                  Step 5: Target PostgreSQL Schema Inspection {snapshot ? `(${snapshot.id})` : ''}
                </span>
              </h3>
              {tables.length > 0 ? (
                <>
                  <p className="text-xs text-infra-muted">
                    Found {tables.length} relational table{tables.length > 1 ? 's' : ''} in target schema.
                  </p>
                  <div className="space-y-3 pt-1">
                    {tables.map((tbl: any, idx: number) => (
                      <div key={idx} className="p-3.5 rounded-lg bg-infra-surface border border-infra-border text-xs font-mono space-y-1.5">
                        <div className="flex justify-between items-center">
                          <span className="font-bold text-sky-400">Table: {tbl.name}</span>
                          <span className="text-infra-muted">{tbl.columns?.length || 0} columns</span>
                        </div>
                        {Array.isArray(tbl.columns) && tbl.columns.length > 0 && (
                          <p className="text-[11px] text-infra-muted">
                            Columns: {tbl.columns.map((c: any) => `${typeof c === 'string' ? c : c.name} (${c.type || 'text'})`).join(', ')}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="p-6 rounded-xl bg-infra-surface border border-dashed border-infra-border space-y-2 text-center">
                  <Database size={24} className="mx-auto text-sky-400" />
                  <p className="text-xs font-mono text-infra-text font-bold">Live Catalog Inspection Scheduled</p>
                  <p className="text-[11px] text-infra-muted max-w-md mx-auto">
                    Destination PostgreSQL schema for {selectedTarget?.name || targetConnId} will be queried live via <code>information_schema</code> during preflight dry run (Step 10) to validate relational tables, foreign keys, and unique constraints.
                  </p>
                </div>
              )}
            </div>
          );
        })()}

        {/* Step 6: AI Mapping Recommendations */}
        {currentStep === 6 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
                  <Sparkles size={16} className="text-emerald-400" />
                  <span>Step 6: AI Mapping Recommendations & Rationale</span>
                </h3>
                <p className="text-xs text-infra-muted mt-0.5">
                  Call the live Schema Mapping AI Agent to synthesize field mappings and type conversions.
                </p>
              </div>

              <button
                onClick={handleGetAiSuggestions}
                disabled={aiLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-semibold bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 transition-colors"
              >
                {aiLoading ? <RefreshCw size={12} className="animate-spin" /> : <Sparkles size={12} />}
                <span>{aiSuggestions ? 'Refresh AI Suggestions' : 'Synthesize AI Mappings'}</span>
              </button>
            </div>

            {aiError && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs font-mono text-rose-300 flex items-center gap-2">
                <AlertCircle size={15} className="text-rose-400 shrink-0" />
                <span>{aiError}</span>
              </div>
            )}

            <div className="p-4 rounded-xl bg-infra-surface border border-emerald-500/30 text-xs font-mono space-y-2">
              <p className="text-emerald-300 font-bold">
                {aiSuggestions
                  ? 'Synthesized Proposal (Live AI Agent):'
                  : isDemo
                  ? 'Demo Mode Sample Recommendations:'
                  : 'Schema Mapping AI Agent'}
              </p>
              {aiSuggestions ? (
                <pre className="p-3 rounded bg-black/40 text-[11px] text-infra-text overflow-x-auto max-h-48 font-mono">
                  {JSON.stringify(aiSuggestions, null, 2)}
                </pre>
              ) : isDemo ? (
                <ul className="list-disc pl-5 space-y-1 text-infra-text font-sans">
                  <li>Map <code>customers.createdAt</code> to <code>created_at</code> using <code>PARSE_TIMESTAMP</code>.</li>
                  <li>Convert <code>customers.email</code> using <code>LOWERCASE</code> to satisfy unique constraint.</li>
                  <li>Serialize complex <code>customers.address</code> object using <code>TO_JSONB</code>.</li>
                  <li>Normalize array <code>customers.orders[]</code> into relational child table <code>public.orders</code>.</li>
                </ul>
              ) : (
                <p className="text-infra-muted font-sans">
                  No AI mapping proposals fetched yet. Click <span className="text-emerald-300 font-semibold">Synthesize AI Mappings</span> above to query the backend Schema Mapping AI Agent.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Step 7: Visual Mapping Review & Allowlist Rules */}
        {currentStep === 7 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
                  <GitCompare size={16} className="text-indigo-400" />
                  <span>Step 7: Mapping Version DSL Review & Persistence</span>
                </h3>
                <p className="text-xs text-infra-muted mt-0.5">
                  Inspect canonical DSL, validate allowlisted operators, and persist version updates.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleValidateMapping}
                  disabled={isValidatingMapping || !selectedMappingVersion?.id}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-semibold bg-infra-surface border border-indigo-500/40 text-indigo-300 hover:bg-infra-cardHover"
                >
                  {isValidatingMapping ? <RefreshCw size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                  <span>Validate DSL</span>
                </button>

                <button
                  onClick={handleSaveMappingEdits}
                  disabled={isSavingMapping}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-semibold bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/40"
                >
                  {isSavingMapping ? <RefreshCw size={12} className="animate-spin" /> : <Plus size={12} />}
                  <span>Save New Version</span>
                </button>
              </div>
            </div>

            {mappingActionError && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs font-mono text-rose-300 flex items-center gap-2">
                <AlertCircle size={15} className="text-rose-400 shrink-0" />
                <span>{mappingActionError}</span>
              </div>
            )}

            {mappingValidationResult && (
              <div
                className={`p-3 rounded-lg border text-xs font-mono ${
                  mappingValidationResult.valid
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                }`}
              >
                <span className="font-semibold">
                  DSL Validation: {mappingValidationResult.valid ? 'PASS (0 blocking issues)' : 'FAILED'}
                </span>
                {mappingValidationResult.issues?.length > 0 && (
                  <ul className="list-disc pl-5 mt-1 space-y-0.5 text-[11px]">
                    {mappingValidationResult.issues.map((iss: any, idx: number) => (
                      <li key={idx}>{iss.message || JSON.stringify(iss)}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <div className="flex justify-between items-center text-xs font-mono text-infra-muted">
                <span>Active Mapping Version ID: <code className="text-indigo-400">{selectedMappingVersion?.id || 'Pending'}</code></span>
                <span>Version #{(selectedMappingVersion as any)?.version || selectedMappingVersion?.versionNumber || 1}</span>
              </div>
              <textarea
                value={mappingDslText}
                onChange={(e) => {
                  setMappingDslText(e.target.value);
                  invalidateDryRunAndPlanVersion();
                }}
                rows={9}
                className="w-full p-3 rounded-lg bg-black/50 border border-infra-border text-xs font-mono text-infra-heading focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>
        )}

        {/* Step 8: Sample Preview */}
        {currentStep === 8 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <Eye size={16} className="text-emerald-400" />
              <span>Step 8: Sample Transform Preview on In-Memory Documents</span>
            </h3>
            <p className="text-xs text-infra-muted">
              Execute pure deterministic transformation functions on bounded in-memory fixture via backend preview service.
            </p>

            {previewError && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs font-mono text-rose-300 flex items-center gap-2">
                <AlertCircle size={15} className="text-rose-400 shrink-0" />
                <span>{previewError}</span>
              </div>
            )}

            <button
              onClick={handleFetchPreview}
              disabled={previewLoading || !selectedMappingVersion?.id}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-mono font-semibold bg-infra-surface border border-emerald-500/40 text-emerald-300 hover:bg-infra-cardHover transition-colors"
            >
              {previewLoading ? <RefreshCw size={14} className="animate-spin" /> : <Eye size={14} />}
              <span>Execute Backend Transform Preview</span>
            </button>
          </div>
        )}

        {/* Step 9: Plan Config */}
        {currentStep === 9 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
                  <Settings size={16} className="text-emerald-400" />
                  <span>Step 9: Migration Plan & Worker Concurrency Settings</span>
                </h3>
                <p className="text-xs text-infra-muted mt-0.5">
                  Configure batch sizing, concurrency parameters, and persist executable plan version in backend.
                </p>
              </div>

              <button
                onClick={ensurePersistedPlanVersion}
                disabled={isPersistingPlan}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono font-semibold bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 transition-colors"
              >
                {isPersistingPlan ? <RefreshCw size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                <span>{resolvedVersionId ? 'Persisted Plan Version Active' : 'Create & Persist Plan Version'}</span>
              </button>
            </div>

            {planPersistError && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs font-mono text-rose-300 flex items-center gap-2">
                <AlertCircle size={15} className="text-rose-400 shrink-0" />
                <span>{planPersistError}</span>
              </div>
            )}

            <div className="grid grid-cols-3 gap-4 pt-2">
              <div className="p-3 rounded-lg bg-infra-surface border border-infra-border text-xs font-mono space-y-1.5">
                <span className="text-infra-muted block text-[10px] uppercase">Batch Size (records)</span>
                <input
                  type="number"
                  value={batchSize}
                  onChange={(e) => {
                    setBatchSize(Number(e.target.value) || 500);
                    invalidateDryRunAndPlanVersion();
                  }}
                  min={50}
                  max={5000}
                  className="w-full px-2.5 py-1.5 rounded bg-black/40 border border-infra-border text-infra-heading font-bold"
                />
              </div>

              <div className="p-3 rounded-lg bg-infra-surface border border-infra-border text-xs font-mono space-y-1.5">
                <span className="text-infra-muted block text-[10px] uppercase">Concurrency (workers)</span>
                <input
                  type="number"
                  value={concurrency}
                  onChange={(e) => {
                    setConcurrency(Number(e.target.value) || 4);
                    invalidateDryRunAndPlanVersion();
                  }}
                  min={1}
                  max={16}
                  className="w-full px-2.5 py-1.5 rounded bg-black/40 border border-infra-border text-infra-heading font-bold"
                />
              </div>

              <div className="p-3 rounded-lg bg-infra-surface border border-infra-border text-xs font-mono space-y-1.5">
                <span className="text-infra-muted block text-[10px] uppercase">Write Mode</span>
                <select
                  value={writeMode}
                  onChange={(e) => {
                    setWriteMode(e.target.value as any);
                    invalidateDryRunAndPlanVersion();
                  }}
                  className="w-full px-2.5 py-1.5 rounded bg-black/40 border border-infra-border text-sky-400 font-bold"
                >
                  <option value="UPSERT">UPSERT (Idempotent)</option>
                  <option value="INSERT_ONLY">INSERT_ONLY (Strict)</option>
                </select>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-infra-surface border border-infra-border text-xs font-mono space-y-1">
              <div className="flex justify-between text-infra-muted">
                <span>Plan Identifier:</span>
                <span className="text-infra-text font-semibold">{plan?.id || 'Pending Generation'}</span>
              </div>
              <div className="flex justify-between text-infra-muted">
                <span>Executable Version ID:</span>
                <span className="text-emerald-400 font-semibold">{resolvedVersionId || 'Will be generated on next step'}</span>
              </div>
            </div>
          </div>
        )}

        {/* Step 10: Dry Run */}
        {currentStep === 10 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
                  <Play size={16} className="text-emerald-400" />
                  <span>Step 10: Deterministic Readiness & Dry-Run Execution</span>
                </h3>
                <p className="text-xs text-infra-muted mt-0.5">
                  Execute bounded sample extraction and transformation against live destination schema. Progression requires a verified zero-violation outcome.
                </p>
              </div>
              <div className="text-right">
                <span className="text-[10px] font-mono text-infra-muted block">Resolved Plan Version ID</span>
                <span className="text-xs font-mono font-semibold text-emerald-400">
                  {resolvedVersionId || 'NO_VERSION_PERSISTED'}
                </span>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-infra-surface border border-infra-border space-y-3">
              <div className="flex items-center gap-3">
                <button
                  onClick={handleTriggerDryRun}
                  disabled={dryRunRunning || dryRunSuccess || isPersistingPlan}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-semibold bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-infra-base transition-colors"
                >
                  {dryRunRunning || isPersistingPlan ? (
                    <RefreshCw size={14} className="animate-spin" />
                  ) : (
                    <Play size={14} />
                  )}
                  <span>
                    {isPersistingPlan
                      ? 'Persisting Plan Version...'
                      : dryRunRunning
                      ? 'Executing Backend Dry Run...'
                      : dryRunSuccess
                      ? 'Dry Run Passed (Verified Live)'
                      : dryRunError
                      ? 'Re-trigger Dry Run'
                      : 'Trigger Live Dry Run'}
                  </span>
                </button>

                {(dryRunRunning || isPersistingPlan) && (
                  <span className="text-xs font-mono text-infra-muted animate-pulse">
                    {isPersistingPlan
                      ? 'Persisting plan version in backend control plane...'
                      : 'Probing destination schema and validating transformations...'}
                  </span>
                )}
              </div>

              {/* Error & Retry State */}
              {dryRunError && (
                <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-xs font-mono text-red-400 space-y-2">
                  <div className="flex items-center gap-2 font-bold text-red-300">
                    <AlertTriangle size={15} />
                    <span>Dry Run Execution Failed</span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-red-300/90">{dryRunError}</p>
                  <div className="flex items-center justify-between pt-1 text-[10px] text-infra-muted border-t border-red-500/20">
                    <span>Progression to Step 11 (Approval) is strictly blocked until a dry run succeeds.</span>
                    <button
                      onClick={handleTriggerDryRun}
                      disabled={dryRunRunning}
                      className="flex items-center gap-1 text-red-300 hover:text-red-200 underline font-semibold"
                    >
                      <RefreshCw size={11} className={dryRunRunning ? 'animate-spin' : ''} />
                      Retry Now
                    </button>
                  </div>
                </div>
              )}

              {/* Verified Success State with Real Measured Metrics */}
              {dryRunSuccess && dryRunDetails && (
                <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs font-mono text-emerald-300 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 font-bold text-emerald-400">
                      <CheckCircle2 size={16} />
                      <span>Dry Run Passed (100% Verified)</span>
                    </div>
                    <span className="text-[10px] text-emerald-400/80">
                      Executed: {dryRunDetails.executedAt ? new Date(dryRunDetails.executedAt).toLocaleTimeString() : 'Just now'}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-[11px]">
                    <div className="bg-black/30 p-2 rounded border border-emerald-500/20">
                      <span className="text-infra-muted block text-[10px]">Sample Tested</span>
                      <span className="font-bold text-emerald-300">
                        {dryRunDetails.sampleRecordsTested ?? dryRunDetails.measuredFacts?.sampleRecordsTested ?? 0} docs
                      </span>
                    </div>
                    <div className="bg-black/30 p-2 rounded border border-emerald-500/20">
                      <span className="text-infra-muted block text-[10px]">Transformed</span>
                      <span className="font-bold text-emerald-300">
                        {dryRunDetails.recordsTransformed ?? dryRunDetails.measuredFacts?.recordsTransformed ?? 0} docs
                      </span>
                    </div>
                    <div className="bg-black/30 p-2 rounded border border-emerald-500/20">
                      <span className="text-infra-muted block text-[10px]">Errors / Conflicts</span>
                      <span className="font-bold text-emerald-400">
                        {dryRunDetails.transformationErrors ?? 0} / {Array.isArray(dryRunDetails.potentialTypeConflicts) ? dryRunDetails.potentialTypeConflicts.length : 0}
                      </span>
                    </div>
                    <div className="bg-black/30 p-2 rounded border border-emerald-500/20">
                      <span className="text-infra-muted block text-[10px]">Duration</span>
                      <span className="font-bold text-emerald-300">
                        {dryRunDetails.measuredFacts?.measuredDurationMs ?? 0} ms
                      </span>
                    </div>
                  </div>

                  <p className="text-[11px] text-emerald-400/90">
                    Zero constraint violations detected. Canonical plan hash{' '}
                    <code className="px-1 py-0.5 rounded bg-black/40 text-emerald-300">
                      {dryRunDetails.planHash ? truncateHash(dryRunDetails.planHash) : truncateHash(plan?.planHash || '')}
                    </code>{' '}
                    is certified ready for cryptographic signing.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Step 11: Hash Approval */}
        {currentStep === 11 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <ShieldCheck size={16} className="text-emerald-400" />
              <span>Step 11: Cryptographic Plan Hash Review & Approval</span>
            </h3>

            {isConfigModifiedSinceDryRun && (
              <div className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs font-mono text-amber-300 flex items-center gap-2">
                <AlertTriangle size={16} className="text-amber-400 shrink-0" />
                <span>
                  Configuration has been altered since the dry run. You must re-run Step 10 (Dry Run) on the new configuration before approving.
                </span>
              </div>
            )}

            <div className="p-4 rounded-xl bg-infra-surface border border-emerald-500/30 space-y-3 font-mono text-xs">
              <div className="flex justify-between items-center">
                <span className="text-infra-muted">Plan Status:</span>
                <Badge variant={plan?.status === 'APPROVED' ? 'emerald' : 'amber'}>
                  {plan?.status || 'DRAFT'}
                </Badge>
              </div>
              <div>
                <span className="text-infra-muted block mb-1">Canonical SHA-256 Hash:</span>
                <div className="p-2.5 rounded bg-black/60 border border-infra-border text-emerald-300 break-all select-all">
                  {plan?.planHash || 'No plan hash computed'}
                </div>
              </div>

              {plan?.status === 'APPROVED' ? (
                <div className="p-2.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-emerald-400" />
                  <span>Approved by {plan.approvedBy || 'Engineer'} at {plan.approvedAt || 'Recently'}</span>
                </div>
              ) : (
                <button
                  onClick={() => setIsApprovalOpen(true)}
                  disabled={isConfigModifiedSinceDryRun || !dryRunSuccess}
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-infra-base transition-colors"
                >
                  Review & Sign Plan Approval
                </button>
              )}
            </div>
          </div>
        )}

        {/* Step 12: Live Execution */}
        {currentStep === 12 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
                  <Activity size={16} className="text-emerald-400" />
                  <span>Step 12: Migration Execution & Streaming Monitor</span>
                </h3>
                <p className="text-xs text-infra-muted mt-0.5">
                  Execute distributed outbox batch run with real-time transactional checkpoints.
                </p>
              </div>

              {!migrationRun && (
                <button
                  onClick={handleStartMigrationRun}
                  disabled={isStartingRun || plan?.status !== 'APPROVED'}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-semibold bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-infra-base transition-colors"
                >
                  {isStartingRun ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
                  <span>Start Migration Run</span>
                </button>
              )}
            </div>

            {runError && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs font-mono text-rose-300 flex items-center gap-2">
                <AlertCircle size={15} className="text-rose-400 shrink-0" />
                <span>{runError}</span>
              </div>
            )}

            {(() => {
              const effectiveRunStatus = runProgress?.status || migrationRun?.status || 'NOT STARTED';
              const hasRealProgress = runProgress && typeof runProgress.percentage === 'number';
              const displayPct = hasRealProgress
                ? Number(runProgress.percentage)
                : isDemo && migrationRun
                ? 85
                : 0;
              const displayThroughput =
                runProgress?.throughputRecordsPerSec !== undefined
                  ? `${runProgress.throughputRecordsPerSec} records/sec`
                  : isDemo && migrationRun
                  ? '425 records/sec'
                  : migrationRun
                  ? '0 records/sec (awaiting batches)'
                  : '—';
              const runBadgeVariant =
                effectiveRunStatus === 'COMPLETED' || effectiveRunStatus === 'MIGRATED' || effectiveRunStatus === 'VALIDATED'
                  ? 'emerald'
                  : effectiveRunStatus === 'FAILED' || effectiveRunStatus === 'CANCELLED'
                  ? 'rose'
                  : migrationRun
                  ? 'sky'
                  : 'slate';

              return (
                <div className="p-4 rounded-xl bg-infra-surface border border-infra-border space-y-3 font-mono text-xs">
                  <div className="flex justify-between items-center">
                    <span>Run ID: <code className="text-emerald-400">{migrationRun?.id || 'Not Started'}</code></span>
                    <Badge variant={runBadgeVariant}>{effectiveRunStatus}</Badge>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex justify-between text-infra-muted text-[11px]">
                      <span>Throughput: {displayThroughput}</span>
                      <span className={displayPct > 0 ? 'text-emerald-400 font-bold' : 'text-infra-muted font-bold'}>
                        {migrationRun || (isDemo && displayPct > 0) ? `${displayPct}% Complete` : 'Not Started (0%)'}
                      </span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-black/60 overflow-hidden">
                      <div
                        className="h-full bg-emerald-400 transition-all duration-500"
                        style={{ width: `${displayPct}%` }}
                      />
                    </div>
                  </div>

                  {runBatches.length > 0 && (
                    <div className="pt-2">
                      <span className="text-[11px] text-infra-muted block mb-1">Batches Processed ({runBatches.length}):</span>
                      <div className="grid grid-cols-4 gap-2 max-h-32 overflow-y-auto">
                        {runBatches.slice(0, 8).map((b) => (
                          <div key={b.id} className="p-1.5 rounded bg-black/40 border border-infra-border text-[10px]">
                            <span className="text-infra-heading font-semibold">#{b.batchIndex ?? (b as any).batchNumber ?? 1}</span> •{' '}
                            <span className="text-emerald-400">{b.recordsCount ?? (b as any).recordsProcessed ?? 0} docs</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {/* Step 13: Validation */}
        {currentStep === 13 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
                  <AlertTriangle size={16} className="text-amber-400" />
                  <span>Step 13: Deterministic Validation & Discrepancy Reconciliation</span>
                </h3>
                <p className="text-xs text-infra-muted mt-0.5">
                  Execute post-migration dual-engine verification to reconcile source and destination records.
                </p>
              </div>

              <button
                onClick={handleTriggerValidation}
                disabled={isValidating || (!isDemo && !migrationRun?.id)}
                className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-mono font-semibold bg-amber-500/20 hover:bg-amber-500/30 disabled:opacity-40 text-amber-300 border border-amber-500/40"
              >
                {isValidating ? <RefreshCw size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                <span>Trigger Validation</span>
              </button>
            </div>

            {valError && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs font-mono text-rose-300 flex items-center gap-2">
                <AlertCircle size={15} className="text-rose-400 shrink-0" />
                <span>{valError}</span>
              </div>
            )}

            {(() => {
              const hasValidation = Boolean(validationRun);
              const valStatus = validationRun?.status || (isDemo ? 'VERIFIED' : 'NOT STARTED');
              const valBadgeVariant =
                valStatus === 'PASSED' || valStatus === 'VERIFIED'
                  ? 'emerald'
                  : valStatus === 'FAILED'
                  ? 'rose'
                  : hasValidation
                  ? 'amber'
                  : 'slate';

              const attachCount = hasValidation
                ? discrepancies.filter((d) => d.category === 'ATTACHMENT_MISSING' || d.category === 'ATTACHMENT_CHECKSUM_MISMATCH').length
                : isDemo
                ? 15
                : null;
              const dupCount = hasValidation
                ? discrepancies.filter((d) => d.category === 'DUPLICATE_RECORD').length
                : isDemo
                ? 10
                : null;
              const brokenRefCount = hasValidation
                ? discrepancies.filter((d) => d.category === 'BROKEN_REFERENCE').length
                : isDemo
                ? 8
                : null;
              const metaMismatchCount = hasValidation
                ? discrepancies.filter((d) => d.category === 'METADATA_MISMATCH').length
                : isDemo
                ? 12
                : null;

              return (
                <div
                  className={`p-4 rounded-xl border text-xs font-mono space-y-3 ${
                    hasValidation || isDemo
                      ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                      : 'bg-infra-surface border-infra-border text-infra-muted'
                  }`}
                >
                  <div className="flex justify-between items-center">
                    <span className="font-bold">Validation Run Status:</span>
                    <Badge variant={valBadgeVariant}>{valStatus}</Badge>
                  </div>

                  {!hasValidation && !isDemo && (
                    <p className="text-[11px] text-infra-muted font-sans">
                      NO DATA — Validation has not been executed for this migration run yet. Start a run in Step 12 and click <span className="text-amber-300 font-semibold">Trigger Validation</span> to obtain live discrepancy metrics.
                    </p>
                  )}

                  <div className="grid grid-cols-4 gap-2 text-center text-[11px]">
                    <div className="p-2 rounded bg-black/40 border border-infra-border">
                      <span className="block text-amber-400 font-bold text-sm">
                        {attachCount !== null ? attachCount : '—'}
                      </span>
                      <span>Missing Attachments</span>
                    </div>
                    <div className="p-2 rounded bg-black/40 border border-infra-border">
                      <span className="block text-amber-400 font-bold text-sm">
                        {dupCount !== null ? dupCount : '—'}
                      </span>
                      <span>Duplicate Records</span>
                    </div>
                    <div className="p-2 rounded bg-black/40 border border-infra-border">
                      <span className="block text-amber-400 font-bold text-sm">
                        {brokenRefCount !== null ? brokenRefCount : '—'}
                      </span>
                      <span>Broken References</span>
                    </div>
                    <div className="p-2 rounded bg-black/40 border border-infra-border">
                      <span className="block text-amber-400 font-bold text-sm">
                        {metaMismatchCount !== null ? metaMismatchCount : '—'}
                      </span>
                      <span>Metadata Mismatches</span>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* Step 14: Export Reports */}
        {currentStep === 14 && (
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-infra-heading font-mono flex items-center gap-2">
              <FileSpreadsheet size={16} className="text-emerald-400" />
              <span>Step 14: Assurance Report Export & Immutable Audit Timeline</span>
            </h3>
            <p className="text-xs text-infra-muted">
              Download certified audit reports and CSV evidence logs for corporate compliance.
            </p>

            {!isDemo && !validationRun?.id && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs font-mono text-amber-300 flex items-center gap-2">
                <AlertTriangle size={15} className="text-amber-400 shrink-0" />
                <span>Complete Step 13 validation first before generating compliance reports.</span>
              </div>
            )}

            {reportError && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs font-mono text-rose-300 flex items-center gap-2">
                <AlertCircle size={15} className="text-rose-400 shrink-0" />
                <span>{reportError}</span>
              </div>
            )}

            {reportSuccessMessage && (
              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs font-mono text-emerald-300 flex items-center gap-2">
                <CheckCircle2 size={15} className="text-emerald-400 shrink-0" />
                <span>{reportSuccessMessage}</span>
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => handleDownloadReport('HTML')}
                disabled={isGeneratingHtml || (!isDemo && !validationRun?.id)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-mono font-semibold bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-infra-base transition-colors shadow-md shadow-emerald-500/20"
              >
                {isGeneratingHtml ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
                <span>Download Executive HTML Report</span>
              </button>
              <button
                onClick={() => handleDownloadReport('CSV')}
                disabled={isGeneratingCsv || (!isDemo && !validationRun?.id)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-mono font-semibold bg-infra-surface border border-infra-border hover:bg-infra-cardHover disabled:opacity-40 text-infra-text transition-colors"
              >
                {isGeneratingCsv ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
                <span>Export Detailed Discrepancies CSV</span>
              </button>
            </div>
          </div>
        )}

        {/* Wizard Bottom Navigation Buttons */}
        <div className="flex items-center justify-between pt-6 border-t border-infra-border mt-6">
          <button
            onClick={prevStep}
            disabled={currentStep === 1}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-mono font-medium text-infra-muted hover:text-infra-heading disabled:opacity-30 transition-colors"
          >
            <ArrowLeft size={14} />
            <span>Previous Step</span>
          </button>

          <div className="flex items-center gap-3">
            {currentStep === 3 && (!sourceHandshake?.success || !targetHandshake?.success) && (
              <span className="text-[11px] font-mono text-amber-400 flex items-center gap-1.5 bg-amber-500/10 px-2.5 py-1 rounded border border-amber-500/20">
                <AlertTriangle size={13} />
                <span>Live connection handshake required before advancing</span>
              </span>
            )}
            {currentStep === 10 && !dryRunSuccess && (
              <span className="text-[11px] font-mono text-amber-400 flex items-center gap-1.5 bg-amber-500/10 px-2.5 py-1 rounded border border-amber-500/20">
                <AlertTriangle size={13} />
                <span>Dry run required before advancing</span>
              </span>
            )}

            <button
              onClick={nextStep}
              disabled={
                currentStep === 14 ||
                (currentStep === 3 && (!sourceHandshake?.success || !targetHandshake?.success)) ||
                (currentStep === 10 && !dryRunSuccess)
              }
              className="flex items-center gap-1.5 px-5 py-2 rounded-lg text-xs font-mono font-semibold bg-emerald-500 hover:bg-emerald-400 disabled:opacity-30 disabled:cursor-not-allowed text-infra-base transition-colors shadow-lg shadow-emerald-500/20"
              title={
                currentStep === 3 && (!sourceHandshake?.success || !targetHandshake?.success)
                  ? 'Verify connections in Step 3 before advancing'
                  : currentStep === 10 && !dryRunSuccess
                  ? 'Execute and pass dry run to advance'
                  : undefined
              }
            >
              <span>{currentStep === 14 ? 'Completed' : 'Next Step'}</span>
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Plan Approval Modal */}
      <PlanApprovalModal
        isOpen={isApprovalOpen}
        onClose={() => setIsApprovalOpen(false)}
        plan={plan}
        onApproved={handlePlanApproved}
      />

      {/* Sample Transform Preview Drawer */}
      <TransformPreviewDrawer
        isOpen={isPreviewOpen}
        onClose={() => setIsPreviewOpen(false)}
        previewData={previewData}
      />
    </div>
  );
}
