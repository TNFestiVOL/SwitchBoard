// Fake opencode for launcher tests: reports its argv on stderr (proving the
// prompt arrives as the final positional) and ends with opencode-style JSON
// step-finish events carrying part.tokens and part.cost.
const prompt = process.argv.at(-1) ?? '';
process.stderr.write(`got prompt: ${prompt}\n`);
process.stdout.write(JSON.stringify({ type: 'step_start' }) + '\n');
process.stdout.write(JSON.stringify({
  type: 'step_finish',
  part: { type: 'step-finish', reason: 'stop', tokens: { total: 9, input: 21, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.000123 },
}) + '\n');
process.exit(0);
