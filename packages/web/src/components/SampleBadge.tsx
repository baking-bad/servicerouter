import { sampleNotice } from '../content';

/** Marks sample data, shown until the Platform API serves it (WB-10). */
export const SampleBadge = ({ sample = true }: { readonly sample?: boolean }) => sample
  ? <span className="badge badge-sample" title={sampleNotice} data-sample="true">Sample data</span>
  : null;
