# Field Mapping Configuration

Detailed patterns for configuring request header field mappings.

## Request Header Mapping Table

### Structure

```al
table 71553611 "CTS-CB Request Header Mapping"
{
    fields
    {
        field(1; "Bank System Code"; Code[30])
        {
            // Which bank system this mapping applies to
            TableRelation = "CTS-CB Bank System".Code;
        }
        field(2; "Field No."; Integer)
        {
            // Source field number in the table
        }
        field(3; "Table No."; Integer)
        {
            // Source table number (e.g., Database::"CTS-CB Bank")
        }
        field(4; "Request Parameter Name"; Text[100])
        {
            // JSON property name in the request
        }
    }

    keys
    {
        key(Key1; "Bank System Code", "Field No.", "Table No.")
        {
            Clustered = true;
        }
    }
}
```

### Example Mapping Records

For a bank that needs `sun-user-name` and `sun-user-number` from the Bank table:

| Bank System Code | Field No. | Table No. | Request Parameter Name |
|-----------------|-----------|-----------|------------------------|
| ACCESSPAY | 71553610 | 71553600 | sun-user-name |
| ACCESSPAY | 71553611 | 71553600 | sun-user-number |

Where:
- `71553610` = Field No. of "SUN User Name" in CTS-CB Bank table
- `71553611` = Field No. of "SUN User Number" in CTS-CB Bank table
- `71553600` = Table No. of CTS-CB Bank table

---

## Populate Request Header Codeunit

### Core Logic

```al
codeunit 71553693 "CTS-CB Populate Request Header"
{
    procedure GetValuesFromTable(var RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
        ValueVariant: Variant; var HeaderValues: Dictionary of [Text, Text]; TableNo: Integer)
    begin
        // Filter mappings by table
        RequestHeaderMapping.SetRange("Table No.", TableNo);

        // Loop through each mapping and extract value
        if RequestHeaderMapping.FindSet() then
            repeat
                GetHeaderValues(RequestHeaderMapping, ValueVariant, HeaderValues);
            until RequestHeaderMapping.Next() = 0;
    end;

    procedure GetHeaderValues(RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
        ValueVariant: Variant; var HeaderValues: Dictionary of [Text, Text])
    var
        RecordRefVar: RecordRef;
        FieldRefVar: FieldRef;
    begin
        // Get RecordRef from the variant
        RecordRefVar.GetTable(ValueVariant);

        // Get the field value using field number
        FieldRefVar := RecordRefVar.Field(RequestHeaderMapping."Field No.");

        // Add to dictionary with JSON property name as key
        HeaderValues.Add(RequestHeaderMapping."Request Parameter Name", FieldRefVar.Value);
    end;
}
```

### How It Works

1. Caller passes a record (Bank, BankAccount, etc.) as Variant
2. Codeunit filters mappings by the record's table number
3. For each mapping, extracts field value using RecordRef/FieldRef
4. Adds to Dictionary with the configured JSON property name

---

## Adding New Field Mappings

### Step 1: Identify Required Fields

From Swagger/API documentation, identify required fields:
```yaml
# From API spec
requestBody:
  content:
    application/json:
      schema:
        properties:
          sun-user-name:
            type: string
          sun-user-number:
            type: string
          client-id:
            type: string
```

### Step 2: Find Source Table and Fields

Determine which table/field contains the data:

| API Field | Source Table | Source Field |
|-----------|--------------|--------------|
| sun-user-name | CTS-CB Bank | SUN User Name |
| sun-user-number | CTS-CB Bank | SUN User Number |
| client-id | CTS-CB Bank | Client ID |

### Step 3: Create Mapping Records

```al
// In upgrade/install codeunit
procedure InsertRequestHeaderMappings()
var
    RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
begin
    InsertMapping('NEWBANK', 71553610, 71553600, 'sun-user-name');
    InsertMapping('NEWBANK', 71553611, 71553600, 'sun-user-number');
    InsertMapping('NEWBANK', 71553612, 71553600, 'client-id');
end;

local procedure InsertMapping(BankSystemCode: Code[30]; FieldNo: Integer;
    TableNo: Integer; ParameterName: Text[100])
var
    RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
begin
    RequestHeaderMapping."Bank System Code" := BankSystemCode;
    RequestHeaderMapping."Field No." := FieldNo;
    RequestHeaderMapping."Table No." := TableNo;
    RequestHeaderMapping."Request Parameter Name" := ParameterName;
    if RequestHeaderMapping.Insert() then;
end;
```

---

## Multi-Table Mapping

A single request may need values from multiple tables. Call `Populate` multiple times:

```al
procedure RequestHeader(...) Result: Text
var
    RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
    HeaderValues: Dictionary of [Text, Text];
begin
    SetRequestHeaderMappingFilter(BankSystemCode, RequestHeaderMapping);

    // Get values from Bank table
    Populate(RequestHeaderMapping, Bank, HeaderValues, Bank.RecordId().TableNo());

    // Also get values from BankAccount table
    Populate(RequestHeaderMapping, BankAccount, HeaderValues, BankAccount.RecordId().TableNo());

    // HeaderValues now contains values from both tables
    ...
end;
```

---

## Filtering Patterns

### By Bank System Code

```al
RequestHeaderMapping.SetRange("Bank System Code", BankSystemCode);
```

### Automatic Table Filtering

The `GetValuesFromTable` method automatically filters by table number:

```al
RequestHeaderMapping.SetRange("Table No.", TableNo);
```

This means mappings for different tables don't interfere with each other.

---

## Common Issues

### Missing Field Values

**Symptom:** JSON property is empty or missing
**Cause:** Field number doesn't exist or field is empty
**Fix:** Verify field number and ensure source field has data

### Duplicate Key Error

**Symptom:** "Key already exists in dictionary"
**Cause:** Same `Request Parameter Name` used for different fields
**Fix:** Ensure unique parameter names per bank system

### Wrong Table Reference

**Symptom:** Field value is wrong or causes error
**Cause:** Field number exists in wrong table
**Fix:** Verify `Table No.` matches the field's actual table
