'use client';

import React, { useState } from 'react';
import { AppSidebar } from './AppSidebar';
import { TopNavbar } from './TopNavbar';
import { CopilotDrawer } from '../copilot/CopilotDrawer';

interface LayoutClientShellProps {
  children: React.ReactNode;
}

export function LayoutClientShell({ children }: LayoutClientShellProps) {
  const [copilotOpen, setCopilotOpen] = useState(false);

  return (
    <>
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
    </>
  );
}
