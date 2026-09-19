// Fake agy for launcher tests: ignores its arguments (the prompt travels as the
// final -p value), reports it on stderr, and ends with an agy stream-json result
// event carrying usage.
const prompt = process.argv.at(-1) ?? '';
process.stderr.write(`got prompt: ${prompt}\n`);
process.stdout.write(JSON.stringify({ event: 'init' }) + '\n');
process.stdout.write(JSON.stringify({
  event: 'step_update',
  step_update: { state: 'DONE', usage: { input_tokens: 5, output_tokens: 2 } },
}) + '\n');
process.stdout.write(JSON.stringify({
  event: 'result',
  result: { status: 'SUCCESS', usage: { input_tokens: 11, output_tokens: 7 } },
}) + '\n');
process.exit(0);
