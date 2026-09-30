# File Context Guard

Guidelines for managing file size and context boundaries to ensure maintainability, architectural cohesion, and reliable model reasoning.

## Purpose

Large, monolithic files degrade model attention and reasoning quality during agentic coding sessions. The File Context Guard establishes a soft threshold to encourage cohesive, modular design without imposing rigid, counterproductive limits.

## Core Rules

### 1. ~600-Line Soft Guardrail
- Applies to **human-authored source code** (e.g., TypeScript, Python, shell scripts) and **agent-facing core documents** (such as `CONTEXT.md`, architectural ADRs, and agent operational guides).
- When a file approaches or exceeds ~600 lines, treat it as a trigger to assess whether the file contains multiple distinct responsibilities that can be naturally separated.

### 2. Not a Hard Ceiling
- 600 lines is a soft guideline, not an arbitrary hard ceiling.
- **Never slice files mechanically** just to satisfy a line count metric. Cohesion, readability, and encapsulation always take precedence over line counts.
- If a file is over 600 lines but represents a tightly coupled, single cohesive unit, keeping it intact is preferred over fragmented or superficial abstractions.

### 3. Exemptions
The following categories are explicitly exempt from the 600-line guardrail:
- **Generated code and build artifacts** (e.g., compiled bundles, userscript distribution files like `*.user.js`).
- **Dependency lockfiles** (e.g., `package-lock.json`, `pnpm-lock.yaml`).
- **Vendored code and third-party libraries**.
- **Test fixtures, mock datasets, and recorded snapshots**.

### 4. Scope Discipline (Report, Don't Drive-by Refactor)
- If an existing file exceeds 600 lines but refactoring it is outside the scope of the current issue/task, **do not refactor it on the fly**.
- Unauthorized or drive-by refactoring introduces unnecessary risk and review overhead.
- Instead, report the observation in the issue comments or task summary so maintainers can schedule dedicated refactoring if appropriate.

### 5. Proactive Growth Control
- When creating new scripts, utility modules, agent guidance files, or specification docs, design them to avoid unbounded single-file growth.
- For extensive research investigations, maintain a concise index/summary document and split detailed topic analyses into modular chapters or linked sub-documents rather than appending infinitely into a single document.
