import { logoColors, logoPaths, logoViewBox } from '../logo';

/** The mark for next/og images: the favicon, the app icon, and the social image (WB-9). */
export const LogoImage = ({ size, color = logoColors.onDark }: { readonly size: number; readonly color?: string }) => (
  <svg width={size} height={size} viewBox={`0 0 ${logoViewBox.width} ${logoViewBox.height}`}>
    {logoPaths.map(path => <path key={path.slice(0, 24)} d={path} fill={color} />)}
  </svg>
);
