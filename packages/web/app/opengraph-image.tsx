import { ImageResponse } from 'next/og';

import { LogoImage } from '../src/components/LogoImage';
import { siteName, tagline } from '../src/content';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = `${siteName}: ${tagline}`;

// The social preview (WB-9): the mark from its vector paths, and the tagline
const OpenGraphImage = () => new ImageResponse(
  <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', width: '100%', height: '100%', padding: 80, background: '#17191B' }}>
    <LogoImage size={160} />
    <div style={{ display: 'flex', marginTop: 40, color: 'rgba(255,255,255,0.9)', fontSize: 72, fontWeight: 700 }}>{siteName}</div>
    <div style={{ display: 'flex', marginTop: 12, color: '#18D2A5', fontSize: 40 }}>{tagline}</div>
  </div>,
  size,
);

export default OpenGraphImage;
