const START = Date.now();
const stamp = () => `${((Date.now() - START) / 1000).toFixed(1).padStart(6)}s`;

export const log = {
  info: (msg: string) => console.log(`[${stamp()}] ${msg}`),
  warn: (msg: string) => console.warn(`[${stamp()}] WARN  ${msg}`),
  error: (msg: string) => console.error(`[${stamp()}] ERROR ${msg}`),
  step: (msg: string) => console.log(`[${stamp()}] ---- ${msg}`),
};
