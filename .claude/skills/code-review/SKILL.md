---
name: code-review
description: AL code review skill for Continia Banking. Reviews ONLY staged files (git diff --cached) against CLAUDE.md and .claude/rules/coding-rules/*.md standards. Provides precise Object→Procedure→Line references with VS Code navigation. Use when users say "review my code", "code review", "/review", "check my changes", "review staged changes", or "PR review".
---

# AL Code Review

Review staged AL code changes against team standards.

## Workflow

1. Read `CLAUDE.md` for team coding standards
2. Read all `.claude/rules/coding-rules/*.md` files
3. Get staged changes: `git diff --cached --unified=5`
4. Parse AL object metadata from staged files
5. Map line numbers to procedures
6. Analyze changes against standards
7. Generate issue report with navigation paths

## Git Commands

```bash
# Get staged files
git diff --cached --name-only

# Get staged changes with context
git diff --cached --unified=5
```

**Scope**: ONLY staged files. Ignore unstaged and committed changes.

## AL Object Parsing

For each staged AL file:
- Extract object header: `^(codeunit|page|table|enum)\s+(\d+)\s+"([^"]+)"`
- Map procedure boundaries: `^\s*(local\s+)?procedure\s+(\w+)`
- Track which procedure contains each changed line

## Review Checklist

Check staged changes against these categories. See `references/review-checklist.md` for complete details.

### Critical Violations
- SetLoadFields missing before Get/Find
- TryFunction with database writes (Insert/Modify/Delete)
- Breaking changes to public APIs without ObsoleteState
- Secrets/credentials in code

### Code Structure
- Early-exit pattern violations (nested if instead of guard clauses)
- Incorrect `var` parameter usage
- Naming convention violations

### Performance
- Unfiltered FIND/FINDSET on large tables
- Missing index usage

## Output Format

Report ONLY issues found. Never report compliant code.

### Issue Template

```markdown
🔴 **Object:** `[FileName]` → `[ProcedureName]()` (Lines [start]-[end])
**Location:** `[full-file-path]:[line-number]`
**Issue:** [Description with rule reference]
**Code Context:**
```al
[3 lines before]
[PROBLEMATIC LINE] ← LINE [X] - [ISSUE]
[2 lines after]
```
**Fix Required:** [Specific fix with code example]
```

### Severity Levels
- 🔴 **BLOCKING** - Must fix (compilation/runtime failures)
- 🟠 **CRITICAL** - CLAUDE.md violations (performance, security)
- 🟡 **STYLE** - Code quality improvements
- ⚠️ **RECOMMENDATIONS** - Best practices

See `references/output-format.md` for detailed format specifications.
See `references/examples.md` for common violation examples.

## Final Status

End with:
- **Status:** APPROVED / REQUIRES CHANGES / REJECTED
- **Summary:** X BLOCKING, Y CRITICAL, Z STYLE issues
- **Quick Navigation:** List top issues with file:line paths

## References

- Team standards: `CLAUDE.md`, `.claude/rules/coding-rules/`
- [AL Developer Reference](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/devenv-reference-overview)
- [TryFunction Attribute](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/attributes/devenv-tryfunction-attribute)
