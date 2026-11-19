-- PostgreSQL Initialization Script
-- Create destination database if not exists
SELECT 'CREATE DATABASE migrationguard_target'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'migrationguard_target')\gexec

\c migrationguard_target;

-- Create destination tables for the standard test dataset (MongoDB customers & orders migration)
CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    tier TEXT,
    created_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    order_number TEXT NOT NULL,
    total_amount NUMERIC(12, 2) NOT NULL,
    status TEXT NOT NULL,
    items JSONB DEFAULT '[]'::jsonb,
    ordered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS customer_attachments (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    file_name TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    content_type TEXT,
    checksum_sha256 TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    created_at TIMESTAMPTZ
);
