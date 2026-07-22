import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserWindow } from 'electron';

/** Print already-sanitized, self-contained HTML in an unprivileged renderer. */
export async function printHtmlToPdf(html: string): Promise<Buffer> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-pdf-'));
  const htmlPath = path.join(tempDir, 'document.html');
  fs.writeFileSync(htmlPath, html, 'utf8');
  const win = new BrowserWindow({
    width: 900,
    height: 1200,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true,
      partition: `texeris-pdf-${randomUUID()}`,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  try {
    await win.loadFile(htmlPath);
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      landscape: false,
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;font:8px sans-serif;text-align:center;color:#666"><span class="pageNumber"></span></div>',
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
