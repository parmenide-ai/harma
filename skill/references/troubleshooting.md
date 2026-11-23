# harma troubleshooting

## Exit code 4: the agent waits on a dialog

The agent waits on a question, and harma kept the task or message aside. At startup it's often "trust this folder?" in a new directory.

1. `harma read <name> --lines 40` to see the question
2. If it's the folder-trust dialog, it follows the trust policy: tell the user what it asks and ask them to answer it in the agent's tab or terminal. If they want harma to handle it in the project folder, they can run `harma trust on` (or ask you to); harma already answers it in the worktrees it creates, unless the user ran `harma trust off`
3. Any other question or permission request: answer it with `harma answer`, as SKILL.md's "Answer a waiting agent" says. Exit code 3 means it needs the user's yes; exit code 4 means the option you named isn't on screen (the hint lists the options)
4. Then `harma wait <name>`: it delivers the task kept aside as soon as the agent is free, and waits through a trust dialog until the user has answered it. `harma send <name> --pending` delivers it now. Neither needs a new yes

## Exit code 4: the task didn't start

The agent stayed idle even after harma sent the task twice ("COMPITO NON PARTITO"). Read the screen with `harma read <name> --lines 40`. When the agent is ready for input, `harma send <name> --pending`. `harma wait` tries a kept task only once, so after a failed try it stops with code 4 instead of sending again. If it keeps failing, tell the user what the screen shows. If harma says the task's file is gone, send the task again with `harma send <name> "…" --yes` after the user's yes.

## Exit code 5: harma wait ran out of time

The agents still work. Run `harma wait` again, or do other work and come back.

## No usable model for a job

`dispatch --task-type` fails when every model on the user's list for that job has a missing CLI or exhausted credits; the hint lists the reason for each. Tell the user and offer options: add a model with `harma select`, wait for the provider's reset, or use `--model` for this dispatch if they pick one. If the user chose "no model" for the job, dispatch refuses it on purpose; ask before working around it.

## Selection screen without a terminal

`harma select` with no options needs an interactive terminal, which you don't have. Use `harma select --open --wait --json`, or ask in chat and record with `--set`.

## Credits are `sconosciuto`

harma has no reliable figure. Say so; don't estimate. Suggest one of: install or start CodexBar, enable the provider in CodexBar, or declare a budget in `.harma/config.json`:

```json
{ "budgets": { "codex": { "limit": 100, "currency": "USD" } } }
```

## A model has no score

The bundled Artificial Analysis snapshot doesn't cover it. If `AA_API_KEY` is set, `harma rank --refresh` may fill it in. An unscored model never appears in proposals, but the user can still choose it.

## Cleanup keeps an agent

`working` or `blocked` agents, agents without a known session id, agents whose task wasn't delivered and agents marked with `harma keep` stay open; `cleanup --agent <name>` closes a marked one. Check with `harma status --json` and `harma read <name>`. Use `--force` only when the user asks, since it loses that agent's context.

## Anything else

`harma doctor` lists what's missing (backends, agent CLIs, CodexBar, AA key, installed skill) and how to install it. Don't start, stop or restart a herdr or hc server yourself.
