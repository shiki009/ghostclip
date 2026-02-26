# GhostClip Agent Pipelines

## Quick Reference

| Pipeline | Command | When to Use | Stages |
|----------|---------|-------------|--------|
| **Feature** | `@clip-orchestrator` | New feature touching 2+ modules | planner -> architect -> implementor -> tester -> reviewer |
| **Bugfix** | `@clip-bug-orchestrator` | Bug report, unknown root cause | triager -> fixer -> tester -> reviewer |
| **Hotfix** | `@clip-hotfix-orchestrator` | Bug with known root cause, needs fast fix | fixer -> reviewer |
| **Refactor** | `@clip-refactor-orchestrator` | Restructure code, preserve behavior | analyzer -> executor -> tester -> reviewer |

## How Pipelines Work

### 1. You describe the work

Tell the orchestrator what you need in natural language:

```
@clip-orchestrator Add JPEG quality slider for downloads
@clip-bug-orchestrator The comparison slider doesn't work on touch devices
@clip-hotfix-orchestrator The generation counter in updatePreview is missing the revoke call
@clip-refactor-orchestrator Extract batch processing logic from main.js into a separate module
```

### 2. The orchestrator creates a work directory

Each pipeline type has its own directory:

```
.planning/
  features/{slug}/      -- feature pipeline
  bugs/{slug}/          -- bugfix pipeline
  hotfixes/{slug}/      -- hotfix pipeline
  refactors/{slug}/     -- refactor pipeline
```

### 3. Agents run in sequence

The orchestrator spawns one agent at a time. Each agent:
- Reads its instructions from `.claude/agents/clip-{name}.md`
- Reads predecessor artifacts from the work directory
- Does its work (investigation, code changes, testing, review)
- Writes its output artifact to the work directory
- Reports status: `complete`, `blocked`, or `failed`

### 4. Artifacts pass between agents

Agents communicate through markdown files with YAML frontmatter:

```yaml
---
feature: webp-export
stage: planner
status: complete
produced_by: clip-planner
consumed_by: clip-architect
---
```

The orchestrator tracks everything in `PIPELINE-STATE.md`:

```
| # | Stage | Agent | Status | Started | Completed | Artifact |
|---|-------|-------|--------|---------|-----------|----------|
| 1 | Plan | clip-planner | complete | 12:00 | 12:02 | 01-SPEC.md |
| 2 | Architect | clip-architect | running | 12:02 | | 02-ARCHITECTURE.md |
| 3 | Implement | clip-implementor | pending | | | 03-IMPLEMENTATION.md |
```

### 5. The reviewer decides the outcome

Every pipeline ends with the reviewer. Three possible verdicts:
- **pass** -- ship it
- **pass-with-warnings** -- ship it, but address the warnings
- **fail** -- the orchestrator determines which stage to re-run

## Running Individual Agents

You can run any agent standalone without a pipeline:

```
# Investigation only
@clip-bug-triager Investigate why batch processing hangs on large images

# Code review only
@clip-reviewer Review sdk.js against GhostClip conventions

# Quick analysis
@clip-refactor-analyzer Map all dependencies of canvas-utils.js

# Direct implementation
@clip-implementor Add a watermark toggle to the export options
```

When running standalone, tell the agent where to write its output.

## Choosing the Right Pipeline

```
"I need a new feature"                    -> @clip-orchestrator (feature)
"Something is broken, not sure why"       -> @clip-bug-orchestrator (bugfix)
"Something is broken, I know the cause"   -> @clip-hotfix-orchestrator (hotfix)
"I want to restructure this code"         -> @clip-refactor-orchestrator (refactor)
"Single-file fix, trivial change"         -> just do it directly, no pipeline needed
```

## Coverage

Every development workflow is covered by either a pipeline or a direct action:

| Workflow | Covered? | How |
|----------|----------|-----|
| Build a new feature | yes | Feature pipeline |
| Fix a bug (unknown cause) | yes | Bugfix pipeline |
| Fix a bug (known cause, fast) | yes | Hotfix pipeline |
| Restructure / reorganize code | yes | Refactor pipeline |
| Code review | yes | `@clip-reviewer` standalone |
| Investigation only | yes | `@clip-bug-triager` standalone |
| Dependency analysis | yes | `@clip-refactor-analyzer` standalone |
| Single-file edit | yes | Direct edit, no pipeline needed |
| Config / build changes | yes | Direct edit, no pipeline needed |
| CI/CD, deployment | no | Infrastructure -- outside agent scope |

## Agent Inventory

### Feature Pipeline (6 agents)
| Agent | Role | Writes Code? |
|-------|------|-------------|
| `clip-orchestrator` | Coordinates feature pipeline | No |
| `clip-planner` | Writes feature spec | No |
| `clip-architect` | Designs technical approach | No |
| `clip-implementor` | Implements all code changes (JS, HTML, CSS, worker, API) | Yes |
| `clip-tester` | Writes tests | Yes |
| `clip-reviewer` | Reviews all changes | No (read-only) |

### Bugfix Pipeline (3 new + reuses tester, reviewer)
| Agent | Role | Writes Code? |
|-------|------|-------------|
| `clip-bug-orchestrator` | Coordinates bugfix pipeline | No |
| `clip-bug-triager` | Investigates root cause | No (read-only) |
| `clip-bug-fixer` | Implements minimal fix | Yes |

### Refactor Pipeline (3 new + reuses tester, reviewer)
| Agent | Role | Writes Code? |
|-------|------|-------------|
| `clip-refactor-orchestrator` | Coordinates refactor pipeline | No |
| `clip-refactor-analyzer` | Maps dependencies, plans steps | No (read-only) |
| `clip-refactor-executor` | Executes refactor changes | Yes |

### Hotfix Pipeline (1 new + reuses bug-fixer, reviewer)
| Agent | Role | Writes Code? |
|-------|------|-------------|
| `clip-hotfix-orchestrator` | Fast-track fix, skip triage | No |

**Total: 13 agent files, 4 pipelines**

## Shared Agents

Some agents are reused across pipelines:

| Agent | Used By |
|-------|---------|
| `clip-tester` | feature, bugfix, refactor |
| `clip-reviewer` | feature, bugfix, hotfix, refactor |
| `clip-bug-fixer` | bugfix, hotfix |
