import * as pty from 'bun-pty';

export function askAuthGeminiCLI(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const proc = pty.spawn('bash', [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' }
    });

    let output = '';
    let ranAuth = false;
    let authWaiting = false;

    proc.onData(async (data: string) => {
      output += data;
      if (authWaiting && data.includes('gemini-') && data.includes('context left)')) {
        authWaiting = false;
        console.log('Auth complete');
        proc.write('/exit');
        await new Promise(res => setTimeout(res, 1000));
        proc.write('\r\n');
        await new Promise(res => setTimeout(res, 1000));
        // -- now stop the process --
        proc.write('exit\r\n');
      } else if (data.includes('gemini-') && data.includes('context left)') && !ranAuth) {
        ranAuth = true;
        proc.write('/auth');
        console.log('Ran auth');
        await new Promise(res => setTimeout(res, 1000));
        proc.write('\r\n');
      }
      else if (data.includes('Get started')) {
        ranAuth = true;
        await new Promise(res => setTimeout(res, 1000));
        proc.write('1\r\n');
        authWaiting = true;
      }
      
    });

    proc.onExit(({ exitCode, signal }) => {
      if (exitCode === 0) {
        resolve(ranAuth);
      } else {
        reject(new Error(`Process exited with code ${exitCode}, signal ${signal}`));
      }
    });

    // Simulate keypresses (with small delay between each for realism)
    (async () => {
      for (const key of ['bunx @google/gemini-cli\n']) {
        await new Promise(res => setTimeout(res, 100)); // 100ms delay
        proc.write(key.toString());
      }
    })();
  });
}
