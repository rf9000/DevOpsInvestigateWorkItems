# Bank-Specific Header Values

Patterns for adding bank-specific values beyond standard field mappings.

## Request Structure Overview

A typical bank API request has these sections:

```json
{
  "transaction-id": "abc-123",
  "company-guid": "def-456",
  "bc-user-name": "user@company.com",
  "authentication": {
    "authentication-items": { ... }
  },
  "sun-user-name": "...",
  "sun-user-number": "...",
  "payload": {
    "file-type": "Pain001",
    "payment-id": "PAY-001",
    "content": "..."
  }
}
```

---

## Build Request Codeunit Sections

### 1. Root Values (Standard Fields)

Added automatically via `BuildRequest.CreateRootValues()`:

```al
procedure CreateRootValues(var Json: JsonObject; var BankSpecificValues: Dictionary of [Text, Text];
    TracingID: Text[50]; IBuildRequestFactory: Interface "CTS-CB IBuildRequestFactory")
begin
    // Standard fields added automatically
    Json.Add('transaction-id', TracingID);
    Json.Add('company-guid', GetCompanyGuid());
    Json.Add('bc-user-name', GetUserEmail());

    // Add any bank-specific values from dictionary
    AddDictionaryToJson(Json, BankSpecificValues);
end;
```

### 2. Authentication Section

Added via `BuildRequest.CreateAuthentication()`:

```al
procedure CreateAuthentication(var Json: JsonObject; BankSystemCode: Code[30];
    Bank: Record "CTS-CB Bank"; IHttpFactory: Interface "CTS-CB IHttpFactory";
    var HeaderValues: Dictionary of [Text, Text]; TransactionType: Enum "CTS-CB Transaction Type")
var
    AuthJson: JsonObject;
begin
    // Get authentication items from stored entry
    AuthJson := GetAuthenticationItems(Bank.Code, BankSystemCode, IHttpFactory);

    // Add authentication object
    Json.Add('authentication', AuthJson);

    // Add mapped header values
    AddDictionaryToJson(Json, HeaderValues);
end;
```

### 3. Payload Section (for Export)

Added via `BuildRequest.CreatePayload()`:

```al
procedure CreatePayload(var Json: JsonObject; Payload: Text; FileType: Text[50]; PaymentId: Text[35])
var
    PayloadJson: JsonObject;
begin
    PayloadJson.Add('file-type', FileType);
    PayloadJson.Add('payment-id', PaymentId);
    PayloadJson.Add('content', Payload);
    Json.Add('payload', PayloadJson);
end;
```

---

## Bank-Specific Custom Values

Some banks require additional fields not in standard tables. Add them programmatically:

### Pattern 1: Add to BankSpecificValues Dictionary

```al
procedure RequestHeader(Bank: Record "CTS-CB Bank"; ...) Result: Text
var
    BankSpecificValues: Dictionary of [Text, Text];
    Json: JsonObject;
begin
    // Add bank-specific value
    BankSpecificValues.Add('config-id', GetConfigId(Bank));
    BankSpecificValues.Add('client-ip', Bank."Client IP");

    // Build request with bank-specific values
    BuildRequest.CreateRootValues(Json, BankSpecificValues, TracingID, ...);
    ...
end;
```

### Pattern 2: Add Directly to JSON

```al
procedure AddBankSpecificValues(var Json: JsonObject; Bank: Record "CTS-CB Bank")
begin
    Json.Add('currency-code', GetCurrency(Bank));
    Json.Add('country-code', Bank."Country/Region Code");
end;
```

### Pattern 3: Dedicated Helper Codeunit

```al
codeunit 71553XXX "CTS-CB {BankName} Account"
{
    procedure AddBankSpecificAuthHeaderValues(Bank: Record "CTS-CB Bank") HeaderValues: Dictionary of [Text, Text]
    begin
        HeaderValues.Add('client-ip', Bank."Client IP");
        HeaderValues.Add('redirect-url', GetRedirectUrl());
    end;

    procedure AddBankSpecificRootHeaderValues(BankAccount: Record "Bank Account";
        var Values: Dictionary of [Text, Text])
    begin
        Values.Add('currency-code', GetCurrency(BankAccount));
        Values.Add('iban', BankAccount.IBAN);
    end;
}
```

---

## Complete Request Building Example

### Authentication Request

```al
procedure RequestHeader(Bank: Record "CTS-CB Bank"; IHttpFactory: Interface "CTS-CB IHttpFactory";
    BankSystemCode: Code[30]; TracingID: Text[50]; RequestValues: Dictionary of [Text, Text];
    TransactionType: Enum "CTS-CB Transaction Type") Result: Text
var
    RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
    BuildRequest: Codeunit "CTS-CB Build Request";
    BankAccountInfoArray: JsonArray;
    Json: JsonObject;
    JsonArrayTxt: Text;
begin
    // 1. Get field mappings
    GetRequestHeaderMapping(RequestHeaderMapping, BankSystemCode);
    Populate(RequestHeaderMapping, Bank, RequestValues, Bank.RecordId().TableNo());

    // 2. Extract special values (accounts array)
    if RequestValues.Get('BankName-accounts', JsonArrayTxt) then begin
        RequestValues.Remove('BankName-accounts');
        BankAccountInfoArray.ReadFrom(JsonArrayTxt);
        Json.Add('accounts', BankAccountInfoArray);
    end;

    // 3. Add standard root values
    BuildRequest.CreateRootValues(Json, RequestValues, TracingID,
        IHttpFactory.GetBuildRequestFactory());

    // 4. Convert to text
    Json.WriteTo(Result);
end;
```

### Export Request with Payload

```al
procedure RequestHeader(Bank: Record "CTS-CB Bank"; IHttpFactory: Interface "CTS-CB IHttpFactory";
    TracingID: Text[50]; FileType: Enum "CTS-CB File Type"; Payload: Text;
    TransactionType: Enum "CTS-CB Transaction Type"; PaymentId: Text[35];
    BankSystemCode: Code[30]) Result: Text
var
    RequestHeaderMapping: Record "CTS-CB Request Header Mapping";
    BuildRequest: Codeunit "CTS-CB Build Request";
    BankSpecificValues: Dictionary of [Text, Text];
    HeaderValues: Dictionary of [Text, Text];
    Json: JsonObject;
begin
    // 1. Get field mappings
    SetRequestHeaderMappingFilter(BankSystemCode, RequestHeaderMapping);
    Populate(RequestHeaderMapping, Bank, HeaderValues, Bank.RecordId().TableNo());

    // 2. Build authentication section
    BuildRequest.CreateAuthentication(Json, BankSystemCode, Bank, IHttpFactory,
        HeaderValues, TransactionType);

    // 3. Add standard root values
    BuildRequest.CreateRootValues(Json, BankSpecificValues, TracingID,
        IHttpFactory.GetBuildRequestFactory());

    // 4. Add payload
    BuildRequest.CreatePayload(Json, Payload,
        CopyStr(FileType.Names().Get(FileType.Ordinals().IndexOf(FileType.AsInteger())), 1, 50),
        PaymentId);

    // 5. Convert to text
    Json.WriteTo(Result);
end;
```

---

## Swagger to AL Mapping Reference

| Swagger Field | AL Source | Method |
|---------------|-----------|--------|
| `transaction-id` | `GetTracingID()` | `CreateRootValues` (auto) |
| `company-guid` | Company GUID | `CreateRootValues` (auto) |
| `bc-user-name` | User Email | `CreateRootValues` (auto) |
| `authentication` | Authentication Entry | `CreateAuthentication` |
| `sun-*` fields | Bank table via mapping | `Populate` |
| `payload` | Export content | `CreatePayload` |
| Custom fields | Programmatic | Direct `Json.Add` |

---

## Best Practices

1. **Use mappings for standard fields** - Configure in Request Header Mapping table
2. **Use dictionary for dynamic values** - Values determined at runtime
3. **Use direct JSON for complex structures** - Arrays, nested objects
4. **Create helper codeunit for bank-specific logic** - Keeps auth/export/import clean
5. **Follow JSON naming convention** - Use kebab-case (`sun-user-name`, not `sunUserName`)
