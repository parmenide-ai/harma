# Command reference

This page lists every `harma` command with its options and exit codes. harma prints its own messages in Italian; every command also takes `--json` for output an agent can parse.

Model targets are written `harness:model`, where the harness is the CLI that runs the model, for example `claude:claude-opus-5-5` or `codex:gpt-6.2-sol`. `harma models` lists the valid pairs on your machine.

## Set up a project

| Command | Description |
|---|---|
| `init --orchestrator harness:model --effort level` | Creates `.harma/` and records the orchestrator |

`init` options:

- `--backend auto|herdr|hc`: terminal backend; `auto` (default) uses herdr when it runs, otherwise `hc`
- `--policy confirm|auto-within-budget`: dispatch policy; `confirm` is the default, see [consent](how-harma-decides.md#consent)
- `--layout auto|workspace|tab|split[:right|:down]`: where herdr agents open by default; see [where agents open](agents-and-sessions.md#where-agents-open)
- `--trust-project`: sets the trust policy to `on`: harma also answers the folder-trust dialog for the project folder; see [folder trust](agents-and-sessions.md#folder-trust)
- `--worktree-copy ".env,…"`: untracked files to copy into each worktree harma creates; same as `harma worktree --copy`

| Command | Description |
|---|---|
| `trust [off\|worktrees\|on]` | Shows or sets who answers the folder-trust dialog: `worktrees` (default) harma for the worktrees it creates, `on` also the project folder, `off` never; records who changed it |
| `worktree [--copy ".env,…"]` | Shows or sets the untracked files harma copies into each worktree it creates |
| `answers [off\|questions\|permissions\|all]` | Shows or sets how far the orchestrator may answer agents that wait on a question or a permission: `permissions` (default) questions and one-time permissions; records who changed it; see [questions and permissions](agents-and-sessions.md#questions-and-permissions) |

## Know your resources

| Command | Description |
|---|---|
| `models` | Agent CLIs on `PATH`, their models and effort levels, with the source of each row |
| `credits` | Remaining share per provider and its state: `ampio`, `ok`, `scarso`, `esaurito` or `sconosciuto` |
| `rank [--refresh] [--top count]` | AA Intelligence Index and cost per task for each model and effort; `--refresh` updates the scores from the AA API |
| `route job [--author harness:model] [--top count]` | Best candidates for a job, your saved choice, and which of your models `dispatch` would use now |

`--author` on `route review` excludes the vendor of the model that wrote the code.

## Choose models

| Command | Description |
|---|---|
| `select` | Opens the selection screen in this terminal |
| `select --open [--wait] [--timeout seconds]` | Opens the screen in a focused herdr tab or an `hc` terminal; `--wait` returns your choices once you save (default timeout 900) |
| `select --set "job=harness:model@effort\|…,…"` | Records choices without the screen; `none` means no model for that job |
| `select --accept` | Accepts every proposal |
| `select --show` | Prints the current choices and proposals |

[Choose the models for each job](choosing-models.md) covers the screen and the `--set` syntax.

## Delegate work

These commands start or instruct an agent, so under the `confirm` policy they need `--yes`. Without it they print the plan and exit with code 3.

| Command | Description |
|---|---|
| `dispatch --name agent_name (--model harness:model [--effort level] \| --task-type job)` | Starts an agent in its own tab or terminal and sends it the task |
| `send agent_name ("text" \| --pending) [--wait] [--timeout seconds]` | Gives an open agent more work; `--pending` delivers the task harma kept aside, with no new `--yes` |
| `read agent_name [--lines count]` | Prints the agent's recent screen output; for a headless job, its answer |

`dispatch` options:

- `--prompt "text"` or `--prompt-file path`: the task to send once the agent starts
- `--task-type job`: uses your saved models for that job, otherwise the best route candidate
- `--cwd path`: working folder for the agent (default: the project root)
- `--wait`: waits until the agent is idle again; `--timeout seconds` (default 600)
- `--author harness:model`: with `--task-type review` and no saved choice, excludes that vendor
- `--layout auto|workspace|tab|split[:right|:down]`: where the agent opens in herdr (default: the project's layout, `auto`: beside the orchestrator while there is room, then a tab)
- `--worktree [--branch name]`: gives the agent its own git worktree on `harma/agent_name`, or the branch you name (herdr only)
- `--headless [--max-time seconds]`: runs the task once in the CLI's print mode and keeps the answer in `.harma/runs/`; needs `--prompt` or `--prompt-file`; see [headless jobs](agents-and-sessions.md#headless-jobs)
- `--machine name --cwd folder`: runs the agent on another machine's herdr server, in that folder; see [another machine](agents-and-sessions.md#another-machine)
- `--keep`: `cleanup` leaves the agent open until you name it; see `keep` below

`dispatch` and `send` check that the agent took the task and send it once more when it didn't. A task that still doesn't arrive, or that a dialog stopped, is kept aside and the command exits with code 4; see [the task reaches the agent](agents-and-sessions.md#the-task-reaches-the-agent).

Agent names are lowercase, start with a letter, use `a-z`, `0-9`, `_` or `-`, are at most 32 characters, and are unique among open agents.

## Watch agents

| Command | Description |
|---|---|
| `status [--all]` | Each open agent: model, effort, live state, whether its task was delivered (`compito`), whether it's kept (`tenuto`), age and session ID; `--all` includes closed agents |
| `wait [agent_name…] [--any] [--timeout seconds]` | Waits until the agents stop (default: every open agent, 540 seconds), delivering tasks kept aside; exits with 4 when one waits on a question, 5 when time runs out; see [wait for agents](agents-and-sessions.md#wait-for-agents) |
| `answer agent_name --kind question\|permission (--option "text or number" [--text "…"] \| --text "…" \| --keys "down,enter") [--reason "…"] [--yes]` | Answers an agent that waits on a question or a permission request, within the answer policy; checks the selected option on screen before Enter |
| `costs` | Estimated cost per agent, credits per provider, and advice on where to delegate more or less |

Live states come from the backend: `working`, `idle`, `done`, `blocked`, `unknown` or `finished`.

## Clean up and resume

| Command | Description |
|---|---|
| `cleanup [--dry-run] [--agent agent_name] [--force] [--workspace]` | Saves session IDs, then closes finished agents |
| `keep agent_name [--off]` | Marks an open agent so that `cleanup` leaves it open until you name it with `--agent`; `--off` removes the mark |
| `resume agent_name [--print-only] [--yes]` | Reopens a closed agent's session with its model and effort (Claude Code, Codex, Muse) |

`cleanup` keeps agents that are `working` or `blocked`, agents whose session ID it can't find, and agents whose task wasn't delivered; `--force` closes them anyway. It also keeps agents marked with `keep`, which only `--agent` closes. `--workspace` also closes the herdr workspace harma created, once no harma agent is open. `resume --print-only` prints the native resume command without running it.

## Install the skill

| Command | Description |
|---|---|
| `install [--target claude\|codex\|both] [--force]` | Copies the skill into `~/.claude/skills/harma` and `~/.codex/skills/harma` |
| `uninstall [--target claude\|codex\|both] [--force]` | Removes the skill harma installed |
| `doctor` | Checks Node.js, catalog, backends, agent CLIs, CodexBar, the AA key and the installed skill |

harma doesn't overwrite or remove a skill folder it didn't install unless you pass `--force`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done |
| 1 | Error; the message says what failed and how to fix it |
| 3 | Needs your confirmation; nothing was started or answered (rerun with `--yes` after you agree) |
| 4 | An agent needs attention: it waits on a dialog, so `dispatch` or `send` kept the task aside or `wait` stopped; the task didn't reach it even when sent twice; or `answer` found no option to pick. See [troubleshooting](troubleshooting.md#an-agent-waits-on-a-dialog) |
| 5 | `wait` ran out of time while agents still work |

## Environment variables

| Variable | Use |
|---|---|
| `AA_API_KEY` | Artificial Analysis API key for `rank --refresh` |
| `HERDR_TAB_ID` | Set by herdr; `select --open` uses it to close its own tab |
