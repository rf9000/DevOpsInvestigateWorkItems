---
name: setup-files-investigate
description: "Investigates JSON setup/configuration files that define banks, bank systems, payment methods, field validations, import/export rules, closing days, ISO transaction codes, CSV ports, bulk payment rules, bank branches, character mappings, and value mappings. Use when asked about: setup files, setup data, bank configuration, field validation rules, bank system config, payment method setup, import setup, export setup, closing days, ISO transaction codes, CSV port definitions, bulk payment rules, bank branch lookup, character mapping, value mapping, validation sets, or when needing to understand what configuration data drives runtime behavior."
---

# Setup Files Investigator

Investigate questions about the JSON configuration files that drive the Continia Banking system. These files live in a sibling repo and are imported into BC tables at runtime.

## When to Use This Skill

- "What field validations does [bank system] have?"
- "Which bank systems support SEPA direct debit?"
- "What are the German bank closing days?"
- "What payment methods does [bank] support?"
- "How is [table/field] configured in setup data?"
- "What ISO transaction codes exist for [domain]?"
- "What CSV port definitions exist for [PSP]?"
- Any question about bank/bank system configuration data

## Setup Files Repo

**Location:** `C:\GeneralDev\AL\Continia Banking Master\Continia Banking - Setup Files\`

This repo contains 830+ JSON files organized by category. Files are deployed to Azure Blob Storage and downloaded into BC tables via the SetupDataManagement import engine.

## Orchestration Flow

```
1. Parse question → identify file category and search target
2. Dispatch agents (setup-data-tracer, optionally al-setup-tracer)
3. Synthesize results
```

## Step 1: Parse the Question

Extract from the user's question:

| Parameter | Description | Examples |
|-----------|-------------|---------|
| **category** | File category (see table below) | Bank, Bank System, Validation, Export Setup |
| **code** | Bank code or bank system code | "DANSKEBANK", "YAPILY", "ABNAMROISO20022" |
| **table** | AL table name in JSON | "CTS-CB Field Validation", "Payment Method" |
| **field** | Specific field or concept | "IBAN", "Amount", "Creditor Name" |
| **scope** | Breadth of search | single file / cross-file / all files |

### File Category Quick Reference

| Question About | File Category | Path Pattern |
|----------------|---------------|--------------|
| Bank name, default import/export, bank system mappings | Bank | `Files/Bank/{BankCode}.json` |
| Bank system config, payment methods, field validations | Bank System | `Files/Bank System/{BankSystemCode}.json` |
| Export-specific bank system config | Bank System - Export | `Files/Bank System - Export/{BankSystemCode}.json` |
| Import-specific config, ISO codes per bank system | Bank System - Import | `Files/Bank System - Import/{BankSystemCode}.json` |
| Global field validations (not bank-specific) | Bank System General | `Files/BankSystemGeneral.json` |
| File architecture, table metadata | General Data | `Files/GeneralData.json` |
| Validation rule DSL definitions | Validation | `Files/Validation.json` |
| Bank closing days (holidays) per country | Export Setup | `Files/ExportSetup.json` |
| ISO bank transaction codes | Import Setup | `Files/ImportSetup.json` |
| PSP/CSV port definitions | PSP | `Files/PSP.json` |
| Danish bank branch directory | Separated Temporary Data | `Files/Separated Temporary Data/BankBranchLookup.json` |

## Step 2: Dispatch Agents

### Always dispatch: Setup Data Tracer

Read `.claude/skills/setup-files-investigate/agents/setup-data-tracer.md` for the agent prompt.

Dispatch as an **Explore** agent to search and read the JSON setup files.

```
Task prompt:
[Include setup-data-tracer.md content]

INPUTS:
- CATEGORY: {category}
- CODE: {code or empty}
- TABLE_NAME: {table name or empty}
- FIELD_NAME: {field name or empty}
- QUESTION: {original user question}
```

### Optionally dispatch: AL Setup Tracer

Read `.claude/skills/setup-files-investigate/agents/al-setup-tracer.md` for the agent prompt.

Dispatch when: the question involves understanding how setup data is used at runtime, how it's imported, or what AL code reacts to it.

```
Task prompt:
[Include al-setup-tracer.md content]

INPUTS:
- TABLE_NAME: {AL table name from JSON key}
- FIELD_NAME: {specific field if applicable}
- QUESTION: {original user question}
```

## Step 3: Synthesize Results

Combine agent findings into a structured answer:

```markdown
## Answer
[Direct answer to the question]

## Setup Data Found
[From Setup Data Tracer: JSON content, file paths, relevant entries]

## AL Usage (if investigated)
[From AL Setup Tracer: how the data maps to AL tables, where it's used at runtime]

## Key Files
- Setup: `Files/Bank System/YAPILY.json` - field validations
- AL: `base-application/.../FieldValidation.Table.al` - runtime table
```

## JSON Structure Patterns

### Bank Files (`Files/Bank/{code}.json`)
Top-level keys: `"CTS-CB Bank"`, `"CTS-CB Bank System Mapping2"`, `"CTS-CB Bulk Payment Rule"`

### Bank System Files (`Files/Bank System/{code}.json`)
Top-level keys: `"Payment Method"`, `"CTS-CB Bank System"`, `"CTS-CB Bank System Pmt. Mth."`, `"CTS-CB Field Validation"`, `"CTS-CB Validation Set"`

### Root-Level Files
- `GeneralData.json`: `"CTS-CB File Architecture"` (self-referential bootstrap)
- `BankSystemGeneral.json`: `"CTS-CB Field Validation"` (global rules)
- `Validation.json`: `"CTS-CB Validation Set"` (validation DSL)
- `ExportSetup.json`: `"CTS-PE Bank Closing Day"` (holidays)
- `ImportSetup.json`: `"CTS-PI ISO Bank Trans. Code"` (ISO codes)
- `PSP.json`: `"CTS-CB CSV Port"` (PSP definitions)

## Connection to AL Code

For detailed architecture, read: `.claude/skills/setup-files-investigate/docs/import-architecture.md`

Key mapping:
- JSON top-level keys = AL table names (e.g., `"CTS-CB Field Validation"` → Table "CTS-CB Field Validation")
- `FileArchitecture` table maps (FileCategory, TableName) → target Table ID + write strategy
- `SetupDataManagement.ImportJson()` uses reflection to map JSON fields → AL table fields by name
- `FileCategory` enum values match the folder/file structure in the setup repo

## Reference Docs

| Doc | When to Read |
|-----|--------------|
| `docs/repo-structure.md` | For detailed file layout, naming conventions, all bank system codes |
| `docs/import-architecture.md` | For AL-side import flow, FileArchitecture, ETag caching, module subscribers |
