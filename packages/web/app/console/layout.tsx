import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { isMocked, readSettings } from '../../src/config';
import { ConsoleRoot } from '../../src/console/ui/ConsoleRoot';

// The console is per person: never indexed (WB-8, WB-11)
export const metadata: Metadata = {
  title: 'Console',
  robots: { index: false, follow: false },
};

/** The console renders in the browser. It gets only public settings: the master key never reaches this server. */
const ConsoleLayout = ({ children }: { readonly children: ReactNode }) => {
  const settings = readSettings();

  return (
    <ConsoleRoot
      settings={{
        apiUrl: settings.apiUrl,
        siteUrl: settings.siteUrl,
        payUrl: settings.payUrl,
        topupMocked: isMocked(settings, 'topup'),
        agentDocsMocked: isMocked(settings, 'agent-docs'),
      }}
    >
      {children}
    </ConsoleRoot>
  );
};

export default ConsoleLayout;
