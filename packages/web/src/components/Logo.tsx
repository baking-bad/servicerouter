import { logoColors, logoPaths, logoViewBox } from '../logo';

/** The Service Router mark (WB-9), from the one copy of its paths. */
export const Logo = ({ color = logoColors.onDark, title }: { readonly color?: string; readonly title?: string }) => (
  <svg viewBox={`0 0 ${logoViewBox.width} ${logoViewBox.height}`} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
    <g fill={color}>
      {logoPaths.map(path => <path key={path.slice(0, 24)} d={path} />)}
    </g>
  </svg>
);
