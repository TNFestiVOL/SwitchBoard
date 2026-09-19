// Fake agent CLI for launcher tests. Usage: node fake-cli.mjs <ok|fail|hang>
const mode = process.argv[2] ?? 'ok';

let stdinLen = 0;
process.stdin.on('data', chunk => { stdinLen += chunk.length; });
process.stdin.on('end', () => {
  if (mode === 'hang') {
    setTimeout(() => process.exit(0), 60_000);
    return;
  }
  if (mode === 'auth-prompt') {
    setTimeout(() => {
      if (process.argv[4] === 'split') {
        process.stdout.write('Please run ');
        setTimeout(() => process.stderr.write('/login to continue\n'), 50);
      } else {
        process.stdout.write('Please run /login to continue\n');
      }
      setTimeout(() => process.exit(0), 20_000);
    }, Number(process.argv[3] ?? 0));
    return;
  }
  if (mode === 'fail') {
    process.stderr.write('something exploded\n');
    process.exit(3);
  }
  // ok: mimic a stream-json session ending in a result line with usage
  process.stderr.write(`read ${stdinLen} bytes of prompt\n`);
  process.stdout.write(JSON.stringify({ type: 'noise', text: 'working...' }) + '\n');
  process.stdout.write(JSON.stringify({
    type: 'result',
    total_cost_usd: 0.12,
    usage: { input_tokens: 900, output_tokens: 400 },
  }) + '\n');
  process.exit(0);
});
process.stdin.resume();
