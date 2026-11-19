export interface CreatePlanDto {
  name: string;
}

export interface CreatePlanVersionDto {
  sourceConnectionId: string;
  sourceSchemaSnapshotId?: string;
  destinationConnectionId: string;
  destinationSchemaSnapshotId?: string;
  mappingVersionId?: string;
  scope: {
    collections?: string[];
    tables?: string[];
  };
  executionConfig: {
    batchSize: number;
    concurrency: number;
    writeMode: 'INSERT_ONLY' | 'UPSERT';
  };
  validationProfile: {
    countCheck: boolean;
    missingRecordCheck: boolean;
    extraRecordCheck: boolean;
    duplicateCheck: boolean;
    contentHashCheck: boolean;
    fieldValidation: boolean;
    attachmentCheck: boolean;
    relationshipCheck: boolean;
    metadataCheck: boolean;
  };
}

export interface ApprovalDto {
  planHash: string;
  decision: 'APPROVE' | 'REJECT';
  comment?: string;
}
