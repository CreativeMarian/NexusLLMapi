import { spawn } from 'node:child_process';

export function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  switch (platform) {
    case 'win32':
      cmd = 'rundll32';
      args = ['url.dll,FileProtocolHandler', url];
      break;
    case 'darwin':
      cmd = 'open';
      args = [url];
      break;
    default:
      cmd = 'xdg-open';
      args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* 浏览器打开失败不影响服务 */ });
    child.unref();
  } catch {
    /* ignore */
  }
}
