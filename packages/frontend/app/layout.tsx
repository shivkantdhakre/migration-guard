import React from 'react';
import type { Metadata, Viewport } from 'next';
import './globals.css';
import { LayoutClientShell } from '../components/layout/LayoutClientShell';

export const metadata: Metadata = {
  title: 'MigrationGuard — AI-Native Data Migration & Assurance Platform',
  description: 'Enterprise MongoDB to PostgreSQL Migration and Deterministic Validation Platform',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark h-full">
      <body className="h-full bg-infra-base text-infra-text flex overflow-hidden antialiased">
        <LayoutClientShell>
          {children}
        </LayoutClientShell>
      </body>
    </html>
  );
}
