import { ImageResponse } from 'next/og';

import { LogoImage } from '../src/components/LogoImage';

export const size = { width: 64, height: 64 };
export const contentType = 'image/png';

// The PNG favicon (WB-9), from the logo's vector paths
const Icon = () => new ImageResponse(
  <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', background: '#17191B', borderRadius: 14 }}>
    <LogoImage size={56} />
  </div>,
  size,
);

export default Icon;
