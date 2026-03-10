# Common Violation Examples

## Early-Exit Pattern Violation

**Bad:**
```al
procedure ProcessExportSelection(Selection: Integer; FilesCollected: Boolean)
begin
    if Selection > 0 then begin
        if FilesCollected then
            ExportFilesToZip()
        else
            Message(NoFilesFoundMsg);
    end;
end;
```

**Good:**
```al
procedure ProcessExportSelection(Selection: Integer; FilesCollected: Boolean)
begin
    if Selection = 0 then
        exit;

    if not FilesCollected then begin
        Message(NoFilesFoundMsg);
        exit;
    end;

    ExportFilesToZip();
end;
```

**Report Format:**
```markdown
🔴 **Object:** `ExportManagement.Codeunit.al` → `ProcessExportSelection()` (Lines 45-58)
**Location:** `base-application/Helper/Codeunits/ExportManagement.Codeunit.al:47`
**Issue:** Nested if statements instead of guard clauses
**CLAUDE.md Rule:** Line 58 - "minimal begin..end; early-exit guard clauses"
```

## SetLoadFields Missing

**Bad:**
```al
procedure GetCurrency(BankAccount: Record "Bank Account"): Text
var
    GeneralLedgerSetup: Record "General Ledger Setup";
begin
    GeneralLedgerSetup.Get();
    if BankAccount."Currency Code" = '' then
        exit(GeneralLedgerSetup."LCY Code")
    else
        exit(BankAccount."Currency Code");
end;
```

**Good:**
```al
procedure GetCurrency(BankAccount: Record "Bank Account"): Text
var
    GeneralLedgerSetup: Record "General Ledger Setup";
begin
    GeneralLedgerSetup.SetLoadFields("LCY Code");
    GeneralLedgerSetup.Get();
    if BankAccount."Currency Code" = '' then
        exit(GeneralLedgerSetup."LCY Code")
    else
        exit(BankAccount."Currency Code");
end;
```

## Parameter Passing - Missing var

**Bad:**
```al
procedure FilterRecords(CustomerRec: Record Customer)
begin
    CustomerRec.SetRange(Blocked, CustomerRec.Blocked::" ");
end;
```

**Good:**
```al
procedure FilterRecords(var CustomerRec: Record Customer)
begin
    CustomerRec.SetRange(Blocked, CustomerRec.Blocked::" ");
end;
```

## TryFunction with Database Write

**Bad:**
```al
[TryFunction]
procedure TryInsertRecord(var Rec: Record MyTable)
begin
    Rec.Insert(true);  // NEVER do this in TryFunction
end;
```

**Good:**
```al
[TryFunction]
procedure TryValidateRecord(Rec: Record MyTable): Boolean
begin
    // Validation only
    if Rec.Code = '' then
        exit(false);
    exit(true);
end;

procedure InsertRecord(var Rec: Record MyTable)
begin
    if not TryValidateRecord(Rec) then
        Error(ValidationFailedErr);
    Rec.Insert(true);
end;
```

## Variable Naming

**Bad:**
```al
var
    FieldMapper: Codeunit "CTS-CB Payment Field Mapper";
    Mgmt: Codeunit "CTS-CB Bank Account Management";
```

**Good:**
```al
var
    PaymentFieldMapper: Codeunit "CTS-CB Payment Field Mapper";
    BankAccountManagement: Codeunit "CTS-CB Bank Account Management";
```

## Error Without Label

**Bad:**
```al
Error('The payment could not be processed');
```

**Good:**
```al
var
    PaymentNotProcessedErr: Label 'The payment could not be processed';
begin
    Error(PaymentNotProcessedErr);
end;
```

## DeleteAll Without Guard

**Bad:**
```al
TempRecord.DeleteAll();
```

**Good:**
```al
if not TempRecord.IsEmpty() then
    TempRecord.DeleteAll();
```
