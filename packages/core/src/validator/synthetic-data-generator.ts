import { createHash } from 'node:crypto';
import {
  AttachmentItem,
  CustomerOrder,
  CustomerRecord,
  ValidationDataset,
} from './discrepancy.types.js';

/**
 * Deterministic PRNG using Mulberry32 algorithm.
 */
export function createRng(seed = 1337): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticGeneratorOptions {
  totalRecords?: number;
  seed?: number;
  objectName?: string;
}

const FIRST_NAMES = [
  'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Ethan', 'Sophia', 'Mason',
  'Isabella', 'William', 'Mia', 'James', 'Charlotte', 'Benjamin', 'Amelia',
  'Lucas', 'Harper', 'Henry', 'Evelyn', 'Alexander', 'Abigail', 'Michael',
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
  'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez',
  'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
];

const CITIES = [
  { city: 'New York', state: 'NY', zip: '10001' },
  { city: 'San Francisco', state: 'CA', zip: '94105' },
  { city: 'Austin', state: 'TX', zip: '78701' },
  { city: 'Seattle', state: 'WA', zip: '98101' },
  { city: 'Chicago', state: 'IL', zip: '60601' },
  { city: 'Boston', state: 'MA', zip: '02108' },
  { city: 'Denver', state: 'CO', zip: '80202' },
];

const MANAGERS = ['Sarah Connor', 'Marcus Brody', 'Elena Fisher', 'Victor Sullivan', 'Arthur Dent'];
const SEGMENTS = ['Enterprise', 'Mid-Market', 'Small-Business', 'Strategic-Accounts'];
const TIERS = ['STANDARD', 'PREMIUM', 'ENTERPRISE'] as const;
const STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED'] as const;
const ORDER_STATUSES = ['COMPLETED', 'SHIPPED', 'PENDING', 'CANCELLED'] as const;

/**
 * Generates a reproducible synthetic dataset of 10,000 customer records
 * with embedded orders, rich metadata, and binary attachments.
 */
export function generateSyntheticDataset(
  options: SyntheticGeneratorOptions = {}
): ValidationDataset {
  const total = options.totalRecords ?? 10000;
  const seed = options.seed ?? 1337;
  const objectName = options.objectName ?? 'customers';

  const rng = createRng(seed);

  const records: CustomerRecord[] = [];
  const allOrders: CustomerOrder[] = [];
  const allAttachments: AttachmentItem[] = [];

  let globalOrderSeq = 1;
  let globalAttSeq = 1;

  for (let i = 1; i <= total; i++) {
    const paddedId = String(i).padStart(6, '0');
    const customerId = `cust_${paddedId}`;

    const firstName = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)];
    const lastName = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)];
    const fullName = `${firstName} ${lastName}`;
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${paddedId}@example.com`;

    const loc = CITIES[Math.floor(rng() * CITIES.length)];
    const streetNum = Math.floor(rng() * 9000) + 100;
    const address = {
      street: `${streetNum} Market Street`,
      city: loc.city,
      state: loc.state,
      zip: loc.zip,
      country: 'USA',
    };

    const year = 2023 + Math.floor(rng() * 2);
    const month = String(Math.floor(rng() * 12) + 1).padStart(2, '0');
    const day = String(Math.floor(rng() * 28) + 1).padStart(2, '0');
    const hour = String(Math.floor(rng() * 24)).padStart(2, '0');
    const min = String(Math.floor(rng() * 60)).padStart(2, '0');
    const createdAt = `${year}-${month}-${day}T${hour}:${min}:00.000Z`;
    const updatedAt = new Date(new Date(createdAt).getTime() + 86400000 * 30).toISOString();

    const status = STATUSES[Math.floor(rng() * STATUSES.length)];
    const tier = TIERS[Math.floor(rng() * TIERS.length)];
    const manager = MANAGERS[Math.floor(rng() * MANAGERS.length)];
    const segment = SEGMENTS[Math.floor(rng() * SEGMENTS.length)];
    const creditScore = 600 + Math.floor(rng() * 250);

    const tagsCount = 1 + Math.floor(rng() * 3);
    const possibleTags = ['verified', 'high-value', 'legacy', 'auto-renew', 'partner-lead'];
    const tags = possibleTags.slice(0, tagsCount);

    const metadata = {
      accountManager: manager,
      segment,
      tags,
      creditScore,
      preferences: {
        newsletter: rng() > 0.5,
        locale: 'en-US',
        notifications: { email: true, sms: rng() > 0.7 },
      },
      customFlags: {
        isBetaTester: rng() > 0.8,
        kycVerified: true,
      },
    };

    // Orders: 1 to 3 orders per customer
    const orderCount = 1 + Math.floor(rng() * 3);
    const customerOrders: CustomerOrder[] = [];

    for (let o = 0; o < orderCount; o++) {
      const orderId = `ord_${String(globalOrderSeq++).padStart(7, '0')}`;
      const amount = Math.round((25 + rng() * 1500) * 100) / 100;
      const orderStatus = ORDER_STATUSES[Math.floor(rng() * ORDER_STATUSES.length)];
      const itemsCount = 1 + Math.floor(rng() * 6);

      const order: CustomerOrder = {
        orderId,
        customerId,
        totalAmount: amount,
        currency: 'USD',
        orderDate: new Date(new Date(createdAt).getTime() + o * 86400000 * 7).toISOString(),
        status: orderStatus,
        itemsCount,
      };
      customerOrders.push(order);
      allOrders.push(order);
    }

    // Attachments: ~30% of customers have an attachment (e.g. contracts, IDs)
    const customerAttachments: AttachmentItem[] = [];
    if (rng() < 0.35) {
      const attId = `att_${String(globalAttSeq++).padStart(6, '0')}`;
      const byteSize = 1024 + Math.floor(rng() * 50000);
      const content = `MIGRATION_GUARD_ATTACHMENT_CONTENT_${attId}_${customerId}_${byteSize}`;
      const checksum = createHash('sha256').update(content, 'utf8').digest('hex');

      const attachment: AttachmentItem = {
        attachmentId: attId,
        recordId: customerId,
        fileName: `agreement_${paddedId}.pdf`,
        contentType: 'application/pdf',
        byteSize,
        checksum,
      };
      customerAttachments.push(attachment);
      allAttachments.push(attachment);
    }

    records.push({
      id: customerId,
      name: fullName,
      email,
      address,
      createdAt,
      updatedAt,
      status,
      tier,
      metadata,
      orders: customerOrders,
      attachments: customerAttachments,
    });
  }

  return {
    objectName,
    records,
    orders: allOrders,
    attachments: allAttachments,
  };
}
