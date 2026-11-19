'use client';

import React, { useState } from 'react';
import './globals.css';
import { AppSidebar } from '../components/layout/AppSidebar';
import { TopNavbar } from '../components/layout/TopNavbar';
import { CopilotDrawer } from '../components/copilot/CopilotDrawer';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [copilotOpen, setCopilotOpen] = useState(false);

  return (
    <html lang="en" className="dark h-full">
      <head>
        <title>MigrationGuard — AI-Native Data Migration & Assurance Platform</title>
        <meta
          name="description"
          content="Enterprise MongoDB to PostgreSQL Migration and Deterministic Validation Platform"
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body className="h-full bg-infra-base text-infra-text flex overflow-hidden antialiased">
        {/* Global Infrastructure Sidebar */}
        <AppSidebar />

        {/* Content Column */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <TopNavbar
            onOpenCopilot={() => setCopilotOpen(true)}
            copilotOpen={copilotOpen}
          />

          <main className="flex-1 overflow-y-auto p-6 bg-infra-base">
            <div className="max-w-7xl mx-auto space-y-6">
              {children}
            </div>
          </main>
        </div>

        {/* Slide-out AI Copilot Drawer */}
        <CopilotDrawer
          isOpen={copilotOpen}
          onClose={() => setCopilotOpen(false)}
        />
      </body>
    </html>
  );
}
