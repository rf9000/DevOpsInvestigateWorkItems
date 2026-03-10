# Controller Routing Matrix

> Last verified: 2026-02-25

The single highest-value lookup table. For each bank controller: which file types are handled locally, which are delegated to the Common Conversion Service, and what happens for unsupported types.

## How to Read This

When BC sends a conversion request with `file-type: "CAMT053"` to bank X:
1. Find bank X in the matrix below
2. Look up `CAMT053` in the file type column
3. The handler column tells you: **Local** (converted in-repo), **SDK** (delegated to Common Conversion Service), or **415/500** (rejected)

## Common Conversion Service Supported Types

These types are handled by the centralized Common Conversion Service (repo: `Online - Continia.Online.Banking.ConversionService`). Any bank that delegates via `ConversionService.ConvertAsync()` can support these:

| File Type | Description |
|---|---|
| `CAMT053` | ISO 20022 bank-to-customer statement |
| `CAMT053E` | CAMT053 Extended variant |
| `CAMT054` | ISO 20022 debit/credit notification |
| `CAMT054C` | CAMT054 Custom variant |
| `PAIN002` | ISO 20022 payment status report |
| `MT940` | SWIFT bank statement |
| `PBSSEKTOR` | PBS Sektor (Danish payment format) |

## Routing Matrix by Bank

### BANKSapi (PSD2)

**Repo:** `Online - Continia.Banking.BANKSapi`
**Route:** `POST /public-api/v1/banksapi/conversion`
**Pattern:** Simplified (Common/Helpers/Converter.cs)

| File Type | Handler | Method/Location |
|---|---|---|
| `CUSTOMPAYMENT` | Local | `Converter.ConvertInhouseToCustomPayment()` |
| `CUSTOMSTATUS` | Local | `Converter.ConvertCustomStatusToBankExportData()` |
| `CUSTOMSTATEMENT` | Local | `Converter.ConvertCustomStatementToBankExportData()` |
| `CUSTOMDIRECTDEBIT` | Local | `Converter.ConvertInhouseToCustomDirectDebit()` |
| **All others** | **HTTP 415** | `ApiError { Message = "File type not supported" }` |

**CAMT053 NOT supported here.** BANKSapi PSD2 has stub methods for CAMT053 in `Converter.cs` (line ~393) that throw `NotImplementedException`. The controller returns 415 before reaching them.

### BANKSAPIEBICS

**Repo:** `Online - Continia.Banking.BANKSAPIEBICS`
**Route:** `POST /public-api/v1/banksapiebics/Conversion`
**Pattern:** Standard (Services/ + SDK delegation)

| File Type | Handler | Method/Location |
|---|---|---|
| `CAMT053` | SDK | `ConversionService.ConvertAsync(Constants.BankName, request)` |
| `CAMT053E` | SDK | `ConversionService.ConvertAsync(Constants.BankName, request)` |
| `CAMT054` | SDK | `ConversionService.ConvertAsync(Constants.BankName, request)` |
| `CAMT054C` | SDK | `ConversionService.ConvertAsync(Constants.BankName, request)` |
| `PAIN002` | SDK | `ConversionService.ConvertAsync(Constants.BankName, request)` |
| `MT940` | SDK | `ConversionService.ConvertAsync(Constants.BankName, request)` |
| `PBSSEKTOR` | SDK | `ConversionService.ConvertAsync(Constants.BankName, request)` |
| `PAIN001` | Local | `Pain00100109Converter` |
| `PAIN008` | Local | `Pain00800108Converter` |
| **All others** | **HTTP 500 (BUG)** | Should be 415. Returns `ApiError { Message = "Unsupported Media Type" }` with status 500 |

**Known bug:** The default case returns HTTP 500 instead of 415:
```csharp
// Bug: statusCode should be 415, not 500
return TypedResults.Json(new ApiError
{
    Message = "Unsupported Media Type",
    Details = $"File type {request.FileType} is not supported"
}, statusCode: 500);
```

### Bizcuit

**Repo:** `Online - Continia.Banking.Bizcuit`
**Controller:** `BizcuitConversionController.cs`

| File Type | Handler | Notes |
|---|---|---|
| `CUSTOMSTATUS` | Local | Bizcuit-specific status conversion |
| `CUSTOMPAYMENT` | Local | Bizcuit-specific payment conversion |
| `CAMT053` | SDK | Delegated to Common Conversion Service |
| `CAMT053E` | SDK | Delegated to Common Conversion Service |
| `PAIN002` | SDK | Delegated to Common Conversion Service |
| **All others** | **HTTP 415** | Standard unsupported type response |

### RaboBank (ISO 20022)

**Repo:** `Online - Continia.Banking.RaboBankISO20022`
**Controller:** `Controllers/v1/ConversionController.cs`
**Pattern:** Standard

| File Type | Handler | Notes |
|---|---|---|
| `CAMT053` | SDK | Delegated to Common Conversion Service |
| `CAMT053E` | SDK | Delegated to Common Conversion Service |
| `CAMT054` | SDK | Delegated to Common Conversion Service |
| `CAMT054C` | SDK | Delegated to Common Conversion Service |
| `PAIN002` | SDK | Delegated to Common Conversion Service |
| `MT940` | SDK | Delegated to Common Conversion Service |
| `PBSSEKTOR` | SDK | Delegated to Common Conversion Service |
| `CUSTOMSTATUS` | Local | Rabo-specific status conversion |
| `PAIN001` | Local | `Pain00100109ConversionService.cs` |
| `PAIN008` | Local | `Pain00800108ConversionService.cs` |
| **All others** | **HTTP 415** | Standard unsupported type response |

## Grouping by Pattern

### CUSTOM-only Controllers (no ISO 20022 delegation)
- **BANKSapi PSD2** — Only handles CUSTOMPAYMENT, CUSTOMSTATUS, CUSTOMSTATEMENT, CUSTOMDIRECTDEBIT

### ISO 20022 Delegators (SDK ConversionService for standard types)
- **BANKSAPIEBICS** — ISO types via SDK + local PAIN001/PAIN008
- **RaboBank** — ISO types via SDK + local PAIN001/PAIN008 + CUSTOMSTATUS
- **Bizcuit** — Subset of ISO types via SDK + local CUSTOMPAYMENT/CUSTOMSTATUS

### Typical New Bank Pattern
Most new banks follow: local CUSTOM* types + SDK delegation for ISO 20022 types + HTTP 415 for everything else.

## SDK ConversionService Bug

`ConversionService.ConvertAsync()` does **NOT** check `response.StatusCode`:

```csharp
public async Task<string> ConvertAsync<TPayload>(...)
{
    HttpResponseMessage response = await httpClient.PostAsJsonAsync(bankCentral, request, cancellationToken);
    return await response.Content.ReadAsStringAsync(cancellationToken);
    // BUG: No response.EnsureSuccessStatusCode() call!
}
```

If the Common Conversion Service returns an error (4xx/5xx), the error body is returned as the "converted" content. The `if (output is null)` check in the controller does NOT trigger (output is a non-null error string), so the error is returned in a **200 OK** response.

## Determining Bank from URL

When a 415 (or 500) is received in BC, the URL reveals which controller was hit:

| URL Segment | Bank Controller |
|---|---|
| `/banksapi/` | BANKSapi PSD2 |
| `/banksapiebics/` | BANKSAPIEBICS |
| `/bizcuit/` | Bizcuit |
| `/RABOBANK20022/` | RaboBank ISO 20022 |
| `/{BankSystemCode}/` | Direct bank system code (EBICS conversion routing) |

## Diagnostic Checklist

When investigating a file type error:

1. **Which bank controller received the request?** (Check URL segment)
2. **What `file-type` was in the request body?** (Check AL FileType enum -> string name)
3. **Is that type in the controller's switch statement?** (See matrix above)
4. **If delegated to SDK, did ConversionService succeed?** (Check for silent error passthrough bug)
5. **Was the URL routed correctly?** (See `al-to-online-routing.md` for the Conversion parameter bug)
