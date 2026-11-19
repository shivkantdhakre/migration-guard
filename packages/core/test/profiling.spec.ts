import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { profileRecords, detectType } from '../dist/profiling/profiler.js';

describe('Data Profiling & Quality Analysis', () => {
  it('should detect granular types accurately', () => {
    assert.equal(detectType('text'), 'string');
    assert.equal(detectType(123), 'integer');
    assert.equal(detectType(123.45), 'float');
    assert.equal(detectType(null), 'null');
    assert.equal(detectType(undefined), 'undefined');
    assert.equal(detectType(new Date()), 'date');
    assert.equal(detectType([1, 2, 3]), 'array');
    assert.equal(detectType({ _bsontype: 'ObjectId' }), 'objectId');
    assert.equal(detectType({ _bsontype: 'Decimal128' }), 'decimal128');
  });

  it('should compute null percentage, counts, and type distributions', () => {
    const records = [
      { id: '1', age: 25, title: 'Engineer' },
      { id: '2', age: 30, title: null },
      { id: '3', age: null, title: 'Manager' },
      { id: '4', age: 40, title: null },
      { id: '5', age: 50, title: 'Director' },
    ];

    const profile = profileRecords('employees', records);

    assert.equal(profile.totalRecordsSampled, 5);

    // Age field checks
    const ageProfile = profile.fields['age'];
    assert.ok(ageProfile);
    assert.equal(ageProfile.nullCount, 1);
    assert.equal(ageProfile.nullPercentage, 20.0);
    assert.equal(ageProfile.min, 25);
    assert.equal(ageProfile.max, 50);

    // Title field checks
    const titleProfile = profile.fields['title'];
    assert.ok(titleProfile);
    assert.equal(titleProfile.nullCount, 2);
    assert.equal(titleProfile.nullPercentage, 40.0);
    assert.equal(titleProfile.typeDistribution['string'], 3);
    assert.equal(titleProfile.typeDistribution['null'], 2);
  });

  it('should flag polymorphic fields and generate quality warnings', () => {
    const polymorphicDocs = [
      { id: '1', mixed_field: '12345' }, // string
      { id: '2', mixed_field: 67890 }, // integer
      { id: '3', mixed_field: true }, // boolean
    ];

    const profile = profileRecords('mixed_coll', polymorphicDocs);
    const fieldProfile = profile.fields['mixed_field'];

    assert.ok(fieldProfile.warnings);
    assert.ok(fieldProfile.warnings.some((w) => w.includes('Polymorphic field')));
    assert.ok(profile.warnings.some((w) => w.includes('mixed_field')));
  });

  it('should detect standard regex patterns (UUID, Email, ISO Date, Numeric string)', () => {
    const records = [
      {
        id: '1',
        user_uuid: '123e4567-e89b-12d3-a456-426614174000',
        contact_email: 'user1@example.com',
        created_at: '2026-11-19T10:00:00.000Z',
        phone_code: '12345',
      },
      {
        id: '2',
        user_uuid: '987fcdeb-51a2-43f7-9012-345678901234',
        contact_email: 'user2@corp.org',
        created_at: '2026-11-19T11:00:00.000Z',
        phone_code: '67890',
      },
    ];

    const profile = profileRecords('users', records, { detectPatterns: true });

    const uuidProfile = profile.fields['user_uuid'];
    assert.ok(uuidProfile.patterns?.some((p) => p.patternName === 'UUID'));

    const emailProfile = profile.fields['contact_email'];
    assert.ok(emailProfile.patterns?.some((p) => p.patternName === 'EMAIL'));

    const dateProfile = profile.fields['created_at'];
    assert.ok(dateProfile.patterns?.some((p) => p.patternName === 'ISO_DATE'));

    const codeProfile = profile.fields['phone_code'];
    assert.ok(codeProfile.patterns?.some((p) => p.patternName === 'NUMERIC_STRING'));
  });
});
