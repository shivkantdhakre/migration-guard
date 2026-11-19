import { Discrepancy, ValidationRunSummary } from '../validator/discrepancy.types.js';

/**
 * Escapes a field according to RFC 4180 rules.
 */
function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  let str: string;
  if (typeof value === 'object') {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }

  // If cell contains commas, quotes, or newlines, quote it and escape internal quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Generates an RFC-4180 compliant CSV export of validation discrepancies.
 */
export function generateDiscrepancyCsv(summary: ValidationRunSummary): string {
  const headers = [
    'issueId',
    'validationRunId',
    'migrationRunId',
    'category',
    'severity',
    'sourceKey',
    'destinationKey',
    'fieldPath',
    'sourceObject',
    'destinationObject',
    'expectedValue',
    'actualValue',
    'explanation',
    'status',
    'timestamp',
  ];

  const lines: string[] = [];
  lines.push(headers.join(','));

  const discrepancies = summary.discrepancies || [];

  for (const disc of discrepancies) {
    const row = [
      escapeCsvCell(disc.issueId),
      escapeCsvCell(disc.validationRunId),
      escapeCsvCell(disc.migrationRunId),
      escapeCsvCell(disc.category),
      escapeCsvCell(disc.severity),
      escapeCsvCell(disc.sourceKey),
      escapeCsvCell(disc.destinationKey),
      escapeCsvCell(disc.fieldPath || ''),
      escapeCsvCell(disc.sourceObject || ''),
      escapeCsvCell(disc.destinationObject || ''),
      escapeCsvCell(disc.expectedValue),
      escapeCsvCell(disc.actualValue),
      escapeCsvCell(disc.explanation),
      escapeCsvCell(disc.status || 'OPEN'),
      escapeCsvCell(disc.timestamp),
    ];
    lines.push(row.join(','));
  }

  return lines.join('\r\n');
}
