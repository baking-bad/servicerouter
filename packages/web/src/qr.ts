import QRCode from 'qrcode';

/** A QR code as an SVG document, black on white, for a deposit address (WB-3). */
export const qrSvg = (text: string): Promise<string> =>
  QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 0, color: { dark: '#000000', light: '#ffffff' } });
