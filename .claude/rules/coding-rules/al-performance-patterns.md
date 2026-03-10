---
paths: "**/*.al"
---

# AL Performance Patterns

Validate these critical performance patterns when writing or reviewing AL code.

---

## Pattern 1: SetLoadFields Before Get/Find

**Rule:** Always use `SetLoadFields` before `Get()`, `Find()`, or `FindSet()` to load only needed fields.

**Exception:** Setup tables (tables with "Setup" in name) are small single-record tables - SetLoadFields not required.

### Why Use SetLoadFields?
- Reduces network traffic between Application Server and SQL Server
- Improves query performance by selecting only needed columns
- Reduces memory usage for large records
- Critical for tables with BLOB fields (File, Content fields)

### Basic Pattern
```al
// GOOD: Load only needed fields
Item.SetLoadFields("No.");
if not Item.Get(ItemNo) then
    exit();

// BAD: Loads all fields unnecessarily
if not Item.Get(ItemNo) then
    exit();
```

### Placement Rules
- Place `SetLoadFields` immediately before the Get/Find call
- Filter fields are auto-loaded - don't include them in SetLoadFields

```al
// GOOD: SetLoadFields after SetRange, before FindFirst
Item.SetRange("Third Party Item Exists", false);
Item.SetLoadFields("Item Category Code");
Item.FindFirst();
```

### For Looping Operations
```al
// GOOD: Set load fields before loop
FileArchive.SetLoadFields("Entry No.", Type, File, FileName);
FileArchive.SetRange(Type, TransactionType);
if FileArchive.FindSet() then
    repeat
        // Process records
    until FileArchive.Next() = 0;
```

### With BLOB Fields
```al
// GOOD: Load metadata first, then CalcFields for BLOB when needed
RequestLog.SetLoadFields("Entry No.", "Transaction Type", "Request Header Content");
if RequestLog.FindFirst() then begin
    if RequestLog."Request Header Content".HasValue() then begin
        RequestLog.CalcFields("Request Header Content"); // Only calc when needed
        // Process BLOB content
    end;
end;
```

### Expanded Example
```al
// GOOD: Load only needed fields
CustomerRec.SetLoadFields("No.", Name, "Phone No.");
if CustomerRec.Get(CustomerNo) then begin
    // Use only the loaded fields
    Message('Customer %1: %2, Phone: %3', CustomerRec."No.", CustomerRec.Name, CustomerRec."Phone No.");
end;

// BAD: Loads all fields unnecessarily
if CustomerRec.Get(CustomerNo) then begin
    Message('Customer %1: %2', CustomerRec."No.", CustomerRec.Name);
end;
```

---

## Pattern 2: DeleteAll with IsEmpty Guard

**Rule:** Always check `IsEmpty()` before `DeleteAll()` to avoid unnecessary table locks.

An empty DeleteAll still acquires a table lock, causing performance issues.

### Bad Code
```al
TempBuffer.SetRange(Code, 'AJ');
TempBuffer.DeleteAll(true);
```

### Good Code
```al
TempBuffer.SetRange(Code, 'AJ');
if not TempBuffer.IsEmpty() then
    TempBuffer.DeleteAll(true);
```

---

## Pattern 3: Subscriber Codeunit Design

**Rules for event subscriber codeunits:**

1. **Use SingleInstance = true** - Avoids reloading codeunit each invocation
2. **Keep codeunits small** - Split by functionality (Sales-subs, Purchase-subs)
3. **Move business logic out** - Subscribers should call method codeunits
4. **Consider manual binding** - Use BindSubscription/UnbindSubscription when applicable
5. **Avoid OnInsert/OnModify/OnDelete** - These break bulk operations

### Bad Code
```al
codeunit 50100 "All Subs"
{
    // NO SingleInstance - reloads every call!

    [EventSubscriber(ObjectType::Table, Database::"Sales Header", 'OnAfterInsertEvent', '', false, false)]
    local procedure OnAfterInsertSalesHeader(var Rec: Record "Sales Header")
    var
        // Large amounts of business logic HERE - bad!
    begin
        // 50+ lines of code directly in subscriber
    end;
}
```

### Good Code
```al
codeunit 50100 "Sales Subs"
{
    SingleInstance = true;  // Loaded once per session

    [EventSubscriber(ObjectType::Table, Database::"Sales Header", 'OnAfterInsertEvent', '', false, false)]
    local procedure OnAfterInsertSalesHeader(var Rec: Record "Sales Header")
    var
        SalesHeaderMgt: Codeunit "Sales Header Mgt.";  // Method codeunit
    begin
        if Rec.IsTemporary() then
            exit;
        SalesHeaderMgt.HandleAfterInsert(Rec);  // Delegate to method codeunit
    end;
}
```

---

## Pattern 4: IsTemporary Safeguard

**Rule:** Check `IsTemporary()` before destructive operations and in event subscribers.

Prevents accidental operations on real data when expecting temporary records.

### Bad Code - Destructive Operation
```al
// Assumes TempBuffer is temporary - dangerous!
TempBuffer.DeleteAll(true);
```

### Good Code - Destructive Operation
```al
if TempBuffer.IsTemporary() then
    TempBuffer.DeleteAll(true);

// OR error if assumption is wrong
if not TempBuffer.IsTemporary() then
    Error(RecNotTemporaryErr);
TempBuffer.DeleteAll(true);
```

### Bad Code - Event Subscriber
```al
[EventSubscriber(ObjectType::Table, Database::"Sales Line", 'OnAfterInsertEvent', '', false, false)]
local procedure OnAfterInsertSalesLine(var Rec: Record "Sales Line")
begin
    DoSomething(Rec);  // Runs for temp records too!
end;
```

### Good Code - Event Subscriber
```al
[EventSubscriber(ObjectType::Table, Database::"Sales Line", 'OnAfterInsertEvent', '', false, false)]
local procedure OnAfterInsertSalesLine(var Rec: Record "Sales Line")
begin
    if Rec.IsTemporary() then
        exit;  // Skip temp records
    DoSomething(Rec);
end;
```

---

## Pattern 5: Read Isolation and Locking (BC v23+)

**Rule:** Use `ReadIsolation` instead of `LockTable`. LockTable disables tri-state locking and "leaks" locks to unrelated code.

### Why ReadIsolation over LockTable?
- **LockTable** = global session state -> ALL record instances of that table get UPDLOCK (including event subscribers!)
- **ReadIsolation** = per-variable -> only affects that specific record variable

### Isolation Levels Quick Reference

| Level | Locks | Default | Use For |
|-------|-------|---------|---------|
| `ReadUncommitted` | None | Before any write | Pages, counts, non-critical reads |
| `ReadCommitted` | None (Cloud) | In write transaction | Clean data to write, allow concurrent access |
| `RepeatableRead` | Keep read lock | - | Read data multiple times, ensure no changes |
| `UpdLock` | Exclusive | After LockTable | Modify records, exclusive access needed |

### Bad Code
```al
local procedure UpdateCustomer(CustomerNo: Code[20])
var
    Customer: Record Customer;
begin
    Customer.LockTable();  // BAD: Affects ALL Customer reads in session!
    Customer.Get(CustomerNo);
    Customer.Name := 'Updated';
    Customer.Modify();
end;
```

### Good Code
```al
local procedure UpdateCustomer(CustomerNo: Code[20])
var
    Customer: Record Customer;
begin
    Customer.ReadIsolation := IsolationLevel::UpdLock;  // Only this variable
    Customer.Get(CustomerNo);
    Customer.Name := 'Updated';
    Customer.Modify();
end;
```

### When to Use Each Level

- **ReadUncommitted**: Display data on pages, CalcSums for UI, IsEmpty checks
- **ReadCommitted**: Read data you'll write (default in write transaction)
- **RepeatableRead**: Must read same data multiple times without changes. **Caveat:** No `RunModal` or `if Codeunit.Run then` allowed after
- **UpdLock**: Exclusive lock before Modify - use sparingly

---

## Pattern 6: Filtering and Keys

**Rule:** Always set filters and use appropriate keys for large table queries.

### Use Proper Filters
```al
// GOOD: Filter early and use indexed fields
FileArchive.SetRange(Type, TransactionType);
FileArchive.SetRange("Import Date", StartDate, EndDate);
FileArchive.SetCurrentKey(Type, "Import Date"); // Use appropriate key
```

### Avoid Unfiltered Operations
```al
// BAD: No filtering on large tables
if FileArchive.FindSet() then // Potentially thousands of records

// GOOD: Always filter
FileArchive.SetRange("Import Date", CalcDate('<-30D>', Today));
if FileArchive.FindSet() then
```

### Common Patterns in Banking App

**File Archive Access:**
```al
FileArchive.SetLoadFields("Entry No.", Type, File, FileName, "Import Date");
FileArchive.SetRange(Type, TransactionType);
FileArchive.SetCurrentKey("Entry No.");
FileArchive.SetAscending("Entry No.", false);
```

**Request Header Log Access:**
```al
RequestHeaderLog.SetLoadFields("Entry No.", "Transaction Type", "Request Header Content", UserID);
RequestHeaderLog.SetRange("Transaction Type", TransactionType);
RequestHeaderLog.SetCurrentKey("Entry No.");
RequestHeaderLog.SetAscending("Entry No.", false);
```

---

## Pattern 7: Bind Functions to Field Expressions Instead of OnAfterGetRecord

**Rule:** For computed/virtual page fields, bind the calculation function directly in the field expression instead of assigning values in `OnAfterGetRecord()`.

### Why?
- `OnAfterGetRecord()` runs for **every record** on every page load, even for hidden fields
- Field expressions are only evaluated when the field is **actually visible/rendered**
- For expensive calculations on fields that are hidden by default (`Visible = false`), this avoids unnecessary computation entirely

### Bad Code
```al
page 50100 "My Ledger Entries"
{
    layout
    {
        area(Content)
        {
            repeater(Lines)
            {
                field(RunningBalance; RunningBalanceValue)
                {
                    Caption = 'Running Balance';
                    Visible = false;
                }
            }
        }
    }

    trigger OnAfterGetRecord()
    begin
        // BAD: Runs for EVERY record even when RunningBalance column is hidden!
        RunningBalanceValue := CalcRunningBalance.GetBalance(Rec);
    end;

    var
        CalcRunningBalance: Codeunit "Calc Running Balance";
        RunningBalanceValue: Decimal;
}
```

### Good Code
```al
page 50100 "My Ledger Entries"
{
    layout
    {
        area(Content)
        {
            repeater(Lines)
            {
                // GOOD: Function bound to field expression - only called when field is visible
                field(RunningBalance; CalcRunningBalance.GetBalance(Rec))
                {
                    Caption = 'Running Balance';
                    Visible = false;
                }
            }
        }
    }

    var
        CalcRunningBalance: Codeunit "Calc Running Balance";
}
```

### When to Use
- Computed fields on list pages with many records
- Fields that are hidden by default (`Visible = false`) but can be shown by the user
- Expensive calculations (running balances, aggregations, external lookups)
- Any page field that currently uses a global variable assigned in `OnAfterGetRecord()`

### When NOT to Use
- Fields that are always visible and always needed (no performance difference)
- When the same calculated value is used by multiple fields (avoid redundant calls)

---

## Quick Validation Checklist

After code changes, verify:

- [ ] Every `Get()` / `Find()` / `FindSet()` has `SetLoadFields` (except Setup tables)
- [ ] Every `DeleteAll()` is preceded by `IsEmpty()` check
- [ ] Subscriber codeunits have `SingleInstance = true`
- [ ] Subscribers delegate to method codeunits (no large inline logic)
- [ ] Event subscribers check `IsTemporary()` at start
- [ ] Destructive operations on temp records validate `IsTemporary()`
- [ ] Use `ReadIsolation` instead of `LockTable` (LC0031)
- [ ] Large table queries have appropriate filters and keys
- [ ] Computed page fields use field expressions (not `OnAfterGetRecord()`) when possible

---

## References

- [SetLoadFields](https://alguidelines.dev/docs/bestpractices/setloadfields/)
- [DeleteAll](https://alguidelines.dev/docs/bestpractices/deleteall/)
- [Subscriber Codeunits](https://alguidelines.dev/docs/bestpractices/subscribercodeunits/)
- [IsTemporary Safeguard](https://alguidelines.dev/docs/bestpractices/istemporary-table-safeguard/)
- [Microsoft SetLoadFields docs](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/methods-auto/record/record-setloadfields-method)
- [Microsoft Performance Guide](https://learn.microsoft.com/dynamics365/business-central/dev-itpro/performance/performance-overview)
- [LockTable: Good or Bad Practice? (Waldo)](https://www.waldo.be/2024/03/28/rec-locktable-good-practice-or-bad-practice/)
- [Tri-State Locking (BC Internals)](https://bcinternals.com/posts/tri-state-locking/)
- [LockTable vs ReadIsolation Scope (KeyToGoodCode)](https://www.keytogoodcode.com/post/locking-scope-differences-between-locktable-and-readisolation)
- [RCSI Impact in Cloud (Demiliani)](https://demiliani.com/2023/11/23/dynamics-365-business-central-sql-server-and-read-committed-snapshot-isolation-impact/)
