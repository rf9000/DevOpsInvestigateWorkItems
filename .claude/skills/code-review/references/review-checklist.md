# Review Checklist

Complete checklist of AL violations to detect during code review.

## Table of Contents
- [Critical Violations](#critical-violations)
- [Code Structure Patterns](#code-structure-patterns)
- [Performance Patterns](#performance-patterns)
- [Error Handling](#error-handling)
- [Variable Naming](#variable-naming)
- [Enum Patterns](#enum-patterns)
- [PageStyle Patterns](#pagestyle-patterns)
- [Breaking Changes](#breaking-changes)

## Critical Violations

### SetLoadFields Missing
- **Pattern**: `Record.Get()` or `Record.Find*()` without preceding `SetLoadFields`
- **Exception**: Setup tables with few fields
- **Check**: Only fields actually used should be loaded

### TryFunction with Database Writes
- **Pattern**: `[TryFunction]` procedure containing `Insert`, `Modify`, or `Delete`
- **Severity**: BLOCKING - causes transaction rollback issues
- **Fix**: Separate validation from write operations

### Secrets in Code
- **Pattern**: String literals containing passwords, API keys, tokens
- **Check**: Look for "password", "secret", "key", "token" in string literals

## Code Structure Patterns

### Early Exit Pattern
- **Violation**: Nested if-else structures
- **Fix**: Use guard clauses with early exit
```al
// Bad
if Condition1 then begin
    if Condition2 then
        DoSomething();
end;

// Good
if not Condition1 then
    exit;
if not Condition2 then
    exit;
DoSomething();
```

### Parameter Passing
- **Rule**: Use `var` ONLY when:
  1. Procedure modifies the parameter, OR
  2. Setting filters on Record variables (SetRange/SetFilter)
- **Violation**: Record parameter without `var` when filters are set
- **Violation**: `var` on parameters that are only read

### Begin..End Usage
- **Rule**: Only use for compound statements (AA0005)
- **Violation**: `begin..end` wrapping single statement

### Unnecessary Else
- **Rule**: Remove else after exit/error
- **Violation**: `if X then exit; else DoY;` (else is unreachable)

## Performance Patterns

### DeleteAll with IsEmpty Guard
```al
// Bad
Rec.DeleteAll();

// Good
if not Rec.IsEmpty() then
    Rec.DeleteAll();
```

### Unfiltered Queries
- **Violation**: `FindFirst`/`FindSet` without `SetRange` on large tables
- **Check**: Verify filters are set before database reads

### Read Isolation
- **Rule**: Use `ReadIsolation` for read-only operations
- **Violation**: `LockTable()` when only reading data

### Caching Repeated Calls
- **Violation**: Method calls inside loops that return same value
- **Fix**: Cache result before loop

## Error Handling

### TryFunction Use Cases (ALLOWED)
- Validation/parsing operations
- HTTP requests
- JSON parsing
- Authentication checks

### TryFunction Restrictions (NEVER)
- Database writes (Insert/Modify/Delete)
- Any operation that should commit on success

### Error Messages
- **Rule**: Always use labels for Error() and Message()
- **Violation**: `Error('Some text')` without label
- **Fix**: Use `Error(SomeErrorLbl)` with localized label

## Variable Naming

### Complex Type Variables
- **Rule**: Variable name should match object name (omit prefix)
- **Example**: `PaymentFieldMapper: Codeunit "CTS-CB Payment Field Mapper"` (correct)
- **Violation**: `FieldMapper: Codeunit "CTS-CB Payment Field Mapper"` (wrong)

### Declaration Order
1. Complex types (Record, Codeunit, Page, etc.)
2. Simple types (Integer, Text, Boolean, etc.)

### Text Constant Suffixes
- `Msg` - Messages
- `Err` - Errors
- `Qst` - Questions
- `Lbl` - Labels
- `Txt` - Text
- `Tok` - Tokens

## Enum Patterns

### Safe Conversions
```al
// Enum to Integer
IntValue := EnumValue.AsInteger();

// Integer to Enum (validate first)
if Enum.FromInteger(IntValue).HasValue() then
    EnumValue := Enum.FromInteger(IntValue);
```

### Extension Safety
- Use `Index` for iteration (0-based, extension-safe)
- Avoid `Ordinal` for iteration (not extension-safe)

## PageStyle Patterns

### StyleExpr Property
- **Rule**: StyleExpr requires Text value, not PageStyle directly
- **Fix**: Use `Format(PageStyle::Value)`
```al
// Bad
StyleExpr := PageStyle::Strong;

// Good
StyleExpr := Format(PageStyle::Strong);
```

## Breaking Changes

### Public API Changes
- **Rule**: Changes to public procedures require ObsoleteState
- **Check**: Modified signatures, removed procedures, changed return types
- **Transition**: Add `ObsoleteState = Pending` before removal

### Internal vs Public
- **Internal** (`Access = Internal`): Breaking changes affect only same app
- **Public** (default): Breaking changes are CRITICAL

### Schema Changes
- Table field changes require upgrade codeunits
- New mandatory fields need default values or upgrade logic
