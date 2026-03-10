---
name: request-header-mapping
description: Guide for understanding and implementing field-to-JSON mapping for bank API requests. Use when (1) adding new fields to bank request headers, (2) understanding how table fields map to JSON properties, (3) implementing bank-specific header values, (4) debugging missing request fields, or (5) creating mapping configurations for new bank systems. Key areas: Request Header Mapping, Field Mapping, JSON Building.
---

# Request Header Mapping

This skill documents how Continia Banking maps table fields to JSON request properties for bank API communication.

## Overview

Bank APIs require specific fields in request headers. Instead of hardcoding these mappings, the system uses:
1. **Request Header Mapping Table** - Configuration of field → JSON property mappings
2. **Populate Request Header Codeunit** - Extracts values from tables using the mappings
3. **Build Request Codeunit** - Constructs the final JSON request

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    REQUEST HEADER BUILDING FLOW                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. Filter Request Header Mapping by BankSystemCode                        │
│     RequestHeaderMapping.SetRange("Bank System Code", BankSystemCode)      │
│                                                                             │
│  2. Populate header values from source table (Bank, BankAccount, etc.)     │
│     PopulateRequestHeader.GetValuesFromTable(                              │
│         RequestHeaderMapping, Bank, HeaderValues, Bank.RecordId().TableNo())│
│                                                                             │
│  3. Build JSON with mapped values + standard fields                        │
│     BuildRequest.CreateAuthentication(Json, BankSystemCode, Bank, ...)     │
│     BuildRequest.CreateRootValues(Json, HeaderValues, TracingID, ...)      │
│                                                                             │
│  4. Add payload if applicable                                               │
│     BuildRequest.CreatePayload(Json, Payload, FileType, PaymentId)         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Key Components

| Component | Purpose |
|-----------|---------|
| `CTS-CB Request Header Mapping` | Table storing field-to-property mappings |
| `CTS-CB Populate Request Header` | Codeunit extracting values from tables |
| `CTS-CB Build Request` | Codeunit building JSON requests |
| `HeaderValues: Dictionary of [Text, Text]` | In-memory key-value pairs |

## Reference Documentation

### `references/field-mapping.md`
Detailed mapping configuration patterns:
- Request Header Mapping table structure
- How to add new field mappings
- Table-specific filtering

**Use when:** Adding new field mappings, debugging missing fields

### `references/bank-specific-values.md`
Bank-specific header patterns:
- Authentication header building
- Root values (transaction-id, company-guid)
- Payload construction
- Bank-specific custom values

**Use when:** Understanding complete request structure

---

## Quick Reference

### Request Header Mapping Table

| Field | Type | Purpose |
|-------|------|---------|
| `Bank System Code` | Code[30] | Which bank system this mapping applies to |
| `Field No.` | Integer | Source field number in the table |
| `Table No.` | Integer | Source table number |
| `Request Parameter Name` | Text[100] | JSON property name |

### Common Pattern

```al
procedure RequestHeader(Bank: Record "CTS-CB Bank"; IHttpFactory: Interface "CTS-CB IHttpFactory";
    TracingID: Text[50]; BankSystemCode: Code[30]; TransactionType: Enum "CTS-CB Transaction Type") Result: Text
var
    RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
    BuildRequest: Codeunit "CTS-CB Build Request";
    HeaderValues: Dictionary of [Text, Text];
    Json: JsonObject;
begin
    // 1. Get mappings for this bank system
    SetRequestHeaderMappingFilter(BankSystemCode, RequestHeaderMapping);

    // 2. Extract values from Bank table using mappings
    Populate(RequestHeaderMapping, Bank, HeaderValues, Bank.RecordId().TableNo());

    // 3. Build authentication section
    BuildRequest.CreateAuthentication(Json, BankSystemCode, Bank, IHttpFactory,
        HeaderValues, TransactionType);

    // 4. Add standard root values (transaction-id, company-guid, bc-user-name)
    BuildRequest.CreateRootValues(Json, HeaderValues, TracingID,
        IHttpFactory.GetBuildRequestFactory());

    // 5. Convert to text
    Json.WriteTo(Result);
end;

procedure Populate(var RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
    ValueVariant: Variant; var HeaderValues: Dictionary of [Text, Text]; TableNo: Integer)
var
    PopulateRequestHeader: Codeunit "CTS-CB Populate Request Header";
begin
    PopulateRequestHeader.GetValuesFromTable(RequestHeaderMapping, ValueVariant, HeaderValues, TableNo);
end;

procedure SetRequestHeaderMappingFilter(BankSystemCode: Code[30];
    var RequestHeaderMapping: Record "CTS-CB Request Header Mapping")
begin
    RequestHeaderMapping.SetRange("Bank System Code", BankSystemCode);
end;
```

---

## Critical Warnings

- **Filter by Table No.** - `GetValuesFromTable` filters by table number automatically
- **Field numbers must exist** - Invalid field numbers cause runtime errors
- **Case-sensitive property names** - JSON property names are exact matches
- **Committed mappings** - Mapping records must be committed before use

## Integration Points

This skill complements:
- `new-bank-communication` - Authentication request headers
- `bank-communication-operations` - Export/Import request headers
- `swagger-api-reader` - Understanding required API fields
