# Troubleshooting

This page covers the situations where harma stops and asks for something, and how to get past each one. Start with `harma doctor`, which checks Node.js, the catalog, the backends, the agent CLIs, CodexBar, the Artificial Analysis key and the installed skill, and says what to install for each missing piece.

## A command exits with code 3

Code 3 isn't an error: harma needs your confirmation before it starts or instructs an agent. It prints the plan (model, effort, command and why) and starts nothing. When you agree, the orchestrator reruns the same command with `--yes`. Your yes covers that one dispatch, not retries or extra agents.

## An agent waits on a dialog

`dispatch` and `send` exit with code 4 when the agent waits on a question; harma keeps the task or message aside. At startup it's often "Do you trust this folder?", the first time a CLI opens a new directory. To continue:

1. Run `harma read agent_name` to see the question
2. The folder-trust dialog: answer it in the agent's tab or terminal. harma already answers it in the worktrees it creates; `harma trust on` extends that to the project folder, see [folder trust](agents-and-sessions.md#folder-trust)
3. Any other question or permission: the orchestrator answers it with `harma answer`, as far as `harma answers` allows, or you answer it in the agent's terminal; see [questions and permissions](agents-and-sessions.md#questions-and-permissions)
4. `harma wait agent_name` delivers the task kept aside as soon as the agent is free; `harma send agent_name --pending` delivers it now

`harma wait` also exits with code 4 when an agent stops on a question while you wait: answer it, then wait again.

## The task didn't start

`dispatch` or `send` exits with code 4 and says the agent stayed idle even after a second send ("COMPITO NON PARTITO"). The agent was busy with something else, such as restarting after an update or showing a message. Read its screen with `harma read agent_name --lines 40`; once it's ready for input, `harma send agent_name --pending` delivers the task harma kept aside. `harma wait` tries such a task once; after that it stops with code 4 and leaves it to `send --pending`.

If the task's file in `.harma/prompts/` is gone (for example after `git clean -X`), `wait` and `send --pending` say so: send the task again with `harma send agent_name "…"`, which replaces it.

## harma wait exits with code 5

The agents still work after `--timeout` seconds (default 540). Run `harma wait` again; the default stays under the 10-minute limit of an agent's shell tool.

## The selection screen needs a terminal

`harma select` without options needs an interactive terminal. An agent has none, so it runs `harma select --open --wait`, which opens the screen in a herdr tab or an `hc` terminal. Without either, record choices with `harma select --set`, `--accept` or `--show`; see [Choose the models for each job](choosing-models.md#choose-without-the-screen).

## Dispatch finds no usable model for a job

`dispatch --task-type` stops when every model you saved for that job is unavailable: its CLI isn't installed or its credits are exhausted. The message lists the reason for each model. Add another model with `harma select`, wait for the provider's reset, or pass `--model harness:model` for this one dispatch.

When you chose "no model" for a job, `dispatch --task-type` refuses it by design; pass `--model` or change the choice.

## Credits show as unknown

`sconosciuto` means harma has no reliable figure for that provider:

- **CodexBar isn't installed or not running**: install [CodexBar](https://github.com/steipete/CodexBar), or declare a budget
- **CodexBar doesn't report this provider**: enable the provider in the CodexBar app
- **No CodexBar and no budget**: add `budgets.<provider>` to `.harma/config.json`, as shown in [How harma decides](how-harma-decides.md#credits)

## A model has no score

The bundled snapshot doesn't cover every model and effort level. Set `AA_API_KEY` and run `harma rank --refresh` to fetch current scores. A model that Artificial Analysis hasn't measured stays unknown and doesn't appear in proposals, but you can still choose it in `harma select` or pass it with `--model`.

## Cleanup keeps an agent open

`cleanup` keeps agents that are `working` or `blocked`, agents whose session ID it can't find, and agents whose task wasn't delivered, because closing them would lose work or context. Check them with `harma status` and `harma read agent_name`. Use `harma cleanup --force` only when you're sure you don't need the session again.

An agent marked with `harma keep` stays open until you name it: `harma cleanup --agent agent_name`, or `harma keep agent_name --off` and then `harma cleanup`.
