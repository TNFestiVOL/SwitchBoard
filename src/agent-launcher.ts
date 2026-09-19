import type { Agent } from './types.js';
import type { AgentTuning, LaunchContext, Launcher, RunResult, CliLauncher } from './launcher.js';
import { NyxLauncher } from './nyx-launcher.js';

/** Routes only nyx to HTTP; claude/codex/gemini continue through the existing CLI launcher. */
export class AgentLauncher implements Launcher {
  constructor(private cli: CliLauncher, private nyx: NyxLauncher) {}

  launch(
    agent: Agent,
    prompt: string,
    cwd: string,
    onOutput?: (chunk: string) => void,
    tuning?: AgentTuning,
    context?: LaunchContext,
  ): Promise<RunResult> {
    if (agent === 'nyx') return this.nyx.launch(agent, prompt, cwd, onOutput, tuning, context);
    return this.cli.launch(agent, prompt, cwd, onOutput, tuning, context);
  }
}
