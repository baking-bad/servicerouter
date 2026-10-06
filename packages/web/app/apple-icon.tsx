import { ImageResponse } from 'next/og';

import { LogoImage } from '../src/components/LogoImage';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

// The app icon (WB-9), from the logo's vector paths
const AppleIcon = () => new ImageResponse(
  <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', background: '#17191B' }}>
    <LogoImage size={150} />
  </div>,
  size,
);

export default AppleIcon;
