import { ajv } from '../validation/schema.js';
import type { ServiceConfigDocument } from './document.js';
import { serviceConfigSchema } from './schema.js';

// The JSON Schema of pass 1 (SR-2), compiled once
export const validateConfigShape = ajv.compile<ServiceConfigDocument>(serviceConfigSchema);
