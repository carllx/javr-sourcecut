# AGENTS.md

## Agent skills

### Issue tracker

GitHub issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`CONTEXT.md` and `docs/adr/`). See `docs/agents/domain.md`.

## Project context guard

### File context guard

~600-line soft guardrail and cohesion rule. See `docs/agents/file-context-guard.md`.

- **Soft guardrail (~600 lines)**: Applies to human-authored code and agent-facing core documents (`CONTEXT.md`, ADRs, agent guides). Exceeding ~600 lines triggers evaluating whether clear, natural, cohesive boundaries exist.
- **Not a hard ceiling**: 600 lines is a soft guideline. Never mechanically slice files or break cohesion just to satisfy an arbitrary line count.
- **Exemptions**: Generated code, lockfiles, vendor bundles, test fixtures, and snapshots are exempt.
- **Scope discipline**: If an oversized file is outside the current issue's scope, report it only; do not perform unauthorized drive-by refactoring.
- **Proactive growth control**: Keep new scripts, agent guidance, and research/spec documents bounded; for large research reports, maintain an index/summary and split by natural topics instead of creating an unbounded monolithic file.
