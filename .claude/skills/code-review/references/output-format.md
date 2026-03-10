# Output Format

## Report Structure

```markdown
# Code Review: [Branch Name]

**Files reviewed:** X staged files
**Focus:** [Primary change summary]

---

## Issues Found

[List issues by severity]

---

## Action Items

### Required Changes (must fix)
- [ ] [Issue 1 with location]
- [ ] [Issue 2 with location]

### Suggested Improvements (should fix)
- [ ] [Improvement 1]

---

## Final Status

**Status:** APPROVED | REQUIRES CHANGES | REJECTED

**Summary:**
- 🔴 X BLOCKING issues
- 🟠 Y CRITICAL issues
- 🟡 Z STYLE issues

**Objects Requiring Changes:**
- `Object1.al` → `Procedure1()`
- `Object2.al` → `Procedure2()`

**VS Code Navigation:**
```
Ctrl+G → ObjectName.al:LineNumber
```
```

## Issue Format

### Complete Issue Template

```markdown
🔴 **Object:** `AccessPayImport.Codeunit.al` → `GetCurrency()` procedure (Lines 352-361)
**Location:** `base-application/Bank Communication/Codeunits/Import/AccessPayImport.Codeunit.al:356`
**Issue:** SetLoadFields missing before GeneralLedgerSetup.Get() - CRITICAL CLAUDE.md Violation
**CLAUDE.md Rule:** Line 69 - "ALWAYS SetLoadFields before Get/Find on records you don't fully consume"
**Performance Impact:** Loading all GeneralLedgerSetup fields when only "LCY Code" is needed
**Code Context:**
```al
procedure GetCurrency(BankAccount: Record "Bank Account"): Text
var
    GeneralLedgerSetup: Record "General Ledger Setup";
begin
    GeneralLedgerSetup.Get();                      ← LINE 356 - MISSING SetLoadFields
    if BankAccount."Currency Code" = '' then
        exit(GeneralLedgerSetup."LCY Code")
```
**Fix Required:**
```al
GeneralLedgerSetup.SetLoadFields("LCY Code");
GeneralLedgerSetup.Get();
```
```

### Compact Issue Format (for minor issues)

```markdown
🟡 **Style:** `FileName.al:123` → `ProcedureName()` - Variable `x` should be `camelCase`
```

## Severity Definitions

### 🔴 BLOCKING
- Compilation errors
- Runtime failures
- Data corruption risks

**Always include:**
- Exact error message
- Object and procedure context
- Direct fix

### 🟠 CRITICAL
- CLAUDE.md violations
- Performance problems
- Security issues

**Always include:**
- Rule reference (CLAUDE.md line or rules file)
- Impact assessment
- Before/after code

### 🟡 STYLE
- Naming conventions
- Code structure
- Readability

**Include:**
- Specific violation
- Correct pattern

### ⚠️ RECOMMENDATIONS
- Best practices
- Optional improvements

**Include:**
- Suggestion
- Benefits

## What NOT to Include

- Compliant code sections
- "Strengths" or "Good job" sections
- Code that follows standards
- Unchanged code analysis
