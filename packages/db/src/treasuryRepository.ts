import { eq } from 'drizzle-orm';

import type { DatabaseExecutor } from './postgres.js';
import { treasuryTransfers } from './schema/payouts.js';

export type TreasuryTransferRecord = typeof treasuryTransfers.$inferSelect;

/** The `treasury_transfers` table (Treasury, TR-4). */
export interface TreasuryRepository {
  findTransfer(reference: string): Promise<TreasuryTransferRecord | undefined>;
  recordTransfer(transfer: TreasuryTransferRecord): Promise<void>;
}

export const createTreasuryRepository = ({ db }: { readonly db: DatabaseExecutor }): TreasuryRepository => ({
  findTransfer: async reference => {
    const [row] = await db.select().from(treasuryTransfers).where(eq(treasuryTransfers.reference, reference));

    return row;
  },
  recordTransfer: async transfer => {
    await db.insert(treasuryTransfers).values(transfer);
  },
});
