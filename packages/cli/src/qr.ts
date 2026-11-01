/** QR codes drawn with half blocks so they fit a terminal. */
export async function terminalQr(text: string): Promise<string> {
  try {
    const QR = await import('qrcode');
    const toString = (QR as unknown as { toString: typeof import('qrcode').toString }).toString ?? (QR as unknown as { default: typeof import('qrcode') }).default.toString;
    return await toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
  } catch (e) {
    return `(QR unavailable: ${(e as Error).message})`;
  }
}
