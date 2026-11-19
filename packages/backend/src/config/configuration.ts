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
  logLevel: string;
  logRedactKeys: string[];
}

export const appConfig: AppConfig = {
  port: parseInt(process.env.PORT || '4000', 10),
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres_secret_password@localhost:5432/migrationguard_control?schema=public',
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  jwtSecret:
    process.env.JWT_SECRET ||
    'migrationguard_super_secure_jwt_dev_secret_key_minimum_32_chars!',
  jwtExpiresIn: '7d',
  encryptionKey:
    process.env.ENCRYPTION_KEY ||
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  logLevel: process.env.LOG_LEVEL || 'debug',
  logRedactKeys: (
    process.env.LOG_REDACT_KEYS ||
    'password,secret,credentials,token,privateKey,connectionString,key,apiKey,auth'
  )
    .split(',')
    .map((k) => k.trim().toLowerCase()),
};
