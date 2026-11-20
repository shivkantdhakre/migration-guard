import * as dotenv from 'dotenv';
dotenv.config();

export interface AppConfig {
  port: number;
  databaseUrl: string;
  redis: {
    host: string;
    port: number;
    password?: string;
  };
  jwtSecret: string;
  jwtExpiresIn: string;
  encryptionKey: string;
  s3: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketAttachments: string;
    bucketReports: string;
    forcePathStyle: boolean;
  };
  ai: {
    provider: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    enabled: boolean;
  };
  logLevel: string;
  logRedactKeys: string[];
}

export const appConfig: AppConfig = {
  port: parseInt(process.env.PORT || '4000', 10),
  databaseUrl: (() => {
    const url = process.env.DATABASE_URL;
    if (process.env.NODE_ENV === 'production') {
      if (!url || url.trim() === '' || url.includes('localhost') || url.includes('127.0.0.1')) {
        throw new Error(
          '[Config] In production (NODE_ENV=production), DATABASE_URL must be explicitly configured and cannot use localhost.',
        );
      }
      return url;
    }
    return (
      url ||
      'postgresql://postgres:postgres_secret_password@localhost:5432/migrationguard_control?schema=public'
    );
  })(),
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  jwtSecret: (() => {
    const secret = process.env.JWT_SECRET;
    const isProduction = process.env.NODE_ENV === 'production';
    const isDevPlaceholder =
      secret === 'migrationguard_super_secure_jwt_dev_secret_key_minimum_32_chars!' ||
      secret === 'secret' ||
      secret === 'changeme';

    if (isProduction) {
      if (!secret || secret.trim() === '' || isDevPlaceholder || secret.length < 32) {
        throw new Error(
          '[Config] JWT_SECRET must be explicitly set to a strong secret (at least 32 characters) in production. ' +
            'Known development placeholders are strictly forbidden.',
        );
      }
      return secret;
    }

    if (secret && !isDevPlaceholder) {
      return secret;
    }

    if (process.env.ALLOW_DEV_JWT === 'true' || process.env.NODE_ENV !== 'production') {
      return 'migrationguard_super_secure_jwt_dev_secret_key_minimum_32_chars!';
    }

    throw new Error(
      '[Config] JWT_SECRET is not configured. Set JWT_SECRET in environment or set ALLOW_DEV_JWT=true for local development.',
    );
  })(),
  jwtExpiresIn: '7d',
  encryptionKey: (() => {
    const key = process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_MASTER_KEY;
    if (!key || key.trim() === '') {
      throw new Error(
        '[Config] ENCRYPTION_KEY (or ENCRYPTION_MASTER_KEY) is not set. ' +
          'Generate a 64-character hex key: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
          'and add it to your environment before starting the backend.',
      );
    }
    return key;
  })(),
  s3: {
    endpoint:
      process.env.S3_ENDPOINT ||
      process.env.AWS_ENDPOINT_URL_S3 ||
      'http://localhost:9000',
    region:
      process.env.S3_REGION ||
      process.env.AWS_REGION ||
      'ap-southeast-1',
    accessKeyId:
      process.env.S3_ACCESS_KEY ||
      process.env.AWS_ACCESS_KEY_ID ||
      '',
    secretAccessKey:
      process.env.S3_SECRET_KEY ||
      process.env.AWS_SECRET_ACCESS_KEY ||
      '',
    bucketAttachments:
      process.env.S3_BUCKET_ATTACHMENTS ||
      'migrationguard-attachments',
    bucketReports:
      process.env.S3_BUCKET_REPORTS ||
      'migrationguard-reports',
    forcePathStyle:
      (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  },
  ai: {
    provider: process.env.AI_PROVIDER || 'gemini',
    apiKey: process.env.GEMINI_API_KEY || process.env.AI_API_KEY || '',
    model: process.env.GEMINI_MODEL || process.env.AI_MODEL_NAME || 'gemini-3.5-flash-lite',
    timeoutMs: parseInt(process.env.AI_TIMEOUT_MS || '30000', 10),
    enabled: process.env.AI_ENABLED !== 'false',
  },
  logLevel: process.env.LOG_LEVEL || 'debug',
  logRedactKeys: (
    process.env.LOG_REDACT_KEYS ||
    'password,secret,credentials,token,privateKey,connectionString,key,apiKey,auth'
  )
    .split(',')
    .map((k) => k.trim().toLowerCase()),
};
