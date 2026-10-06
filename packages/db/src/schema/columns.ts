import { customType } from 'drizzle-orm/pg-core';

/**
 * Bytes. Each value read comes back as a Buffer in memory of its own: the driver's buffers can be
 * views into Node's shared pool, which a clone or `.buffer` would carry along (backlog D-3).
 */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: value => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  fromDriver: value => {
    const copy = Buffer.alloc(value.byteLength);
    copy.set(value);

    return copy;
  },
});
