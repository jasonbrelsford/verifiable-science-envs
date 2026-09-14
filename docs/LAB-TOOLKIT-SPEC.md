# HLA-Verify Lab Toolkit — spec v1 (2026-09-14)

Owner: COO. Branch: `feature/lab-toolkit`. **Do not merge to main or deploy** — pushing
`edge/src/**` to main auto-deploys production; Jason approves the deploy.

Goal: make HLA-Verify the one call a histocompatibility lab, LIMS, or transplant program makes
before a typing leaves the building. Everything is computed from the pinned IPD-IMGT/HLA
release files — no frequency data, no licensed tables, no NMDP-owned data.

Out of scope (decided): NMDP MAC codes (employer-owned data, conflict of interest), DPB1 TCE
groups (redistribution terms unverified), eplets/PIRCHE (proprietary), CIWD (journal data),
ARD reduction of GL strings (overlaps NMDP py-ard; Jason decides later).

## 0. Architecture (unchanged pattern)

1. Python computes every fact (`sci_envs/service/`, PolyForm Noncommercial).
2. `sci_envs/service/edge_export.py` writes per-name facts into the existing shards.
3. `edge/src/engine.js` only looks up rows and mirrors the decision order.
4. `edge/test/gen_fixtures.py` produces golden fixtures from the FastAPI app; `node --test`
   must reproduce every byte. Every new endpoint gets golden fixtures.

Existing endpoint outputs must not change except where §2 adds a key.

## 1. Protein facts — `sci_envs/service/protein.py` (DONE, COO)

`ProteinFacts(ref).residue(allele, position)` reads `alignments/{A,B,C}_prot.txt` (fetched into
the cache on first use; release version checked against the header). Returns a one-letter
residue, `'?'` not sequenced, `'.'` gap, `'X'` stop, or `None` if the allele is absent from the
alignment (8 B alleles in 3.65.0). Validated: B*07:02 Bw6/-21M, B*57:01 Bw4-80I/-21T,
B*27:05 Bw4-80T/-21T, A*24:02 Bw4-80I, C*01:02 & C*07:02 N80 (C1), C*02:02 & C*06:02 K80 (C2),
B*46:01 & B*73:01 V76+N80.

Never output sequences. Only the derived values below.

## 2. Ligand facts for one name — `ligands(ref, pf, name) -> dict | None`

Applies when `split_allele(name)` succeeds and locus ∈ {A, B, C}; otherwise `None` (key omitted).
`HLA-` prefix is tolerated exactly as `split_allele` tolerates it.

Members: `[name]` if `ref.exists(name)`; else `ref.expand(f"{locus}*{':'.join(fields)}")`,
filtered to members whose suffix equals the name's suffix when the name has one.
If no members → `None`.

Expressed members = members whose suffix != `"N"`.

If there are members but no expressed members:
```json
{"expressed": false, "leader_21": "not_expressed", "residue_80": "not_expressed",
 "bw": <"not_expressed" for A/B, null for C>, "c_group": null, "kir_ligand": "none"}
```

Per expressed member `m`, with `r(p) = pf.residue(m, p)`; define `aa(x)` = `x` if `x` is a single
letter A–Z other than `X`, else `"unknown"` (covers `None`, `'?'`, `'.'`, `'X'`):

- `leader_21` = `aa(r(-21))`
- `residue_80` = `aa(r(80))`
- `bw`: locus C → `null`. Else with `p82 = aa(r(82))`, `p83 = aa(r(83))`: if either is
  `"unknown"` → `"unknown"`; `("L","R")` → `"Bw4"`; `("R","G")` → `"Bw6"` for B, `"non-Bw4"` for A;
  otherwise `"unclassified"`.
- `c_group`: locus C → `"C1"` if residue_80 is `N`, `"C2"` if `K`, `"unknown"` if residue_80 is
  `"unknown"`, else `"unclassified"`. Locus B → `"C1"` if `aa(r(76)) == "V"` and residue_80 is `N`,
  else `null`. Locus A → `null`.
- `kir_ligand`:
  - C: `c_group` if it is `C1`/`C2`; `"unknown"` if `c_group == "unknown"`; else `"none"`.
  - A/B: if `bw == "Bw4"` → `"Bw4-80I"` if residue_80 is `I`, `"Bw4-80T"` if `T`, else `"Bw4"`;
    elif `c_group == "C1"` → `"C1"`; elif `bw == "unknown"` → `"unknown"`; else `"none"`.

Aggregate each of the five keys over expressed members: `known` = values that are not
`"unknown"` (null counts as a known value). No known values → `"unknown"`; exactly one distinct
known value → that value; more than one → `"ambiguous"`.

Output (keys in this order):
```json
{"expressed": true, "leader_21": "T", "residue_80": "I", "bw": "Bw4", "c_group": null,
 "kir_ligand": "Bw4-80I", "ambiguities": {"leader_21": ["M", "T"]}}
```
`ambiguities` is present only when at least one key is `"ambiguous"`; it maps each ambiguous
key to the sorted list of its distinct known values, with `null` rendered as the string
`"null"` for sorting and output. Keys of `ambiguities` in the order above.

### 2a. `/v1/allele/{name}` (REST + MCP `allele_info`)
For `status` `assigned` or `valid_prefix`, when `ligands(...)` is not `None`, add key
`"ligands"` as the **last** key of the body (after `attribution`/`serology`/`null_allele`/
`members_sample` — i.e., appended at the end of the existing dict).

## 3. `POST /v1/typing/check` — one typing, every QC check

Body: `{"typing": {"A": ["A*01:01", "A*02:01"], "B": [...], "DRB1": [...], ...}}`.
Validation identical to `validateTyping` in `edge/src/handlers.js` with side name `typing`
(≤24 loci, ≤4 strings per locus, each ≤64 chars) → 422 with the same message format.

Canonical locus of a key: `key.strip()`, remove a leading `HLA-`, then `Cw` → `C`.
Locus of a reported string: if it resolves, `split_allele(current_name)[0]`; else the match of
`^(?:HLA-)?([A-Za-z]+[0-9]*)\*` on the stripped string with `Cw` → `C`; else `null`.

Loci are processed in input key order; strings in list order.

Per reported string `s` (row keys in this order):
```json
{"reported": s, "status": "ok|renamed|unresolvable", "current_name": name|"UNRESOLVABLE",
 "allele_2field": ..., "g_group": ..., "flags": [...], "antigen": ...,
 "ligands": {...}}
```
- `name, flags = resolve_name(ref, s)`; `n = normalize(ref, s)`.
- `status`: `unresolvable` if name is None; `renamed` if `"deprecated_name"` in flags; else `ok`.
- `allele_2field`, `g_group` from `n`; `flags` = `n["flags"].split(";")` or `[]`.
- `antigen` = `antigen_of(ref, s)` with `"∅"` → `"null"` and `"?"` → `"uncertain"`.
- `ligands` = `ligands(ref, pf, name)` only when name is not None and the result is not None.

Issues: list of `{"severity": "error|warning|info", "locus": <input key>, "code": ..., "detail": ...}`,
emitted in this order: for each locus, for each string — `unresolvable`, `deprecated_name`,
`locus_mismatch`, `null_allele` (each only if applicable); then that locus's `too_many_alleles`,
`single_allele`, `homozygous`. After all loci: DRB3/4/5 issues (§3b).

| code | severity | when | detail (exact) |
|---|---|---|---|
| `unresolvable` | error | status unresolvable | `'{s}' is not a name in release {release}` |
| `deprecated_name` | warning | status renamed | `'{s}' is an outdated name; current name is {name}` |
| `locus_mismatch` | error | string locus not null and != canonical key locus | `{s} is a {string locus} allele listed under {key}` |
| `null_allele` | warning | `"null_allele"` in row flags | `{name} is a null allele (not expressed)` |
| `too_many_alleles` | warning | more than 2 strings | `{count} alleles listed; a genotype has at most 2 per locus` |
| `single_allele` | info | exactly 1 string | `one allele listed: homozygous or incomplete typing` |
| `homozygous` | info | exactly 2 strings with equal allele_2field != UNRESOLVABLE | `both alleles are {allele_2field}` |

`{s}` is the reported string exactly as given (not stripped). `{release}` e.g. `3.65.0`.

### 3a. `profile`
Only rows whose canonical key locus is A, B or C contribute; take the first 2 rows of that locus.
- `b_leader_genotype`: null if no B key. Else slots from the first 2 B rows: `leader_21` of the
  row's ligands if it is `M` or `T`, otherwise `?` (unresolved, ambiguous, unknown, not expressed,
  missing ligands); pad to 2 slots with `?`. Sort slots by order `M` < `T` < `?`; join with `/`.
- `c_kir_ligand_genotype`: null if no C key. Slots from first 2 C rows: `kir_ligand` if `C1`/`C2`;
  `none` if ligands.expressed is false; otherwise `?`; pad with `?`. Order `C1` < `C2` < `none` < `?`.
- `kir_ligands_present`: sorted distinct `kir_ligand` values in {`C1`,`C2`,`Bw4`,`Bw4-80I`,`Bw4-80T`}
  over all A/B/C rows (all rows, not just the first 2).
- `kir_ligand_status`: `complete` if keys A, B and C are all present, each with exactly 2 rows,
  and every one of those 6 rows has ligands with `kir_ligand` not in {`unknown`,`ambiguous`};
  else `incomplete`.

### 3b. `drb345`
Evaluated only when a key with canonical locus `DRB1` is present.
DRB1 family = first field of the row's current name: `15`,`16` → `DRB5`; `03`,`11`,`12`,`13`,`14`
→ `DRB3`; `04`,`07`,`09` → `DRB4`; `01`,`08`,`10` → none; any other or unresolvable → unknown.
- `expected`: sorted distinct loci from DRB1 rows.
- `reported`: sorted distinct canonical loci among keys `DRB3`/`DRB4`/`DRB5` that have ≥1 row with
  status != unresolvable.
- `determinate`: true iff the DRB1 key has exactly 2 rows and neither family is unknown.
Issues (after all per-locus issues; for each locus in sorted order):
- `drb345_unexpected` (warning), only when `determinate`: locus in reported but not expected —
  detail `{L} reported but neither DRB1 allele is normally carried with {L}`. `locus`: `L`.
- `drb345_not_reported` (info): locus in expected but not reported — detail
  `{L} is normally carried with {comma-space-joined current names of the DRB1 rows mapping to L} but was not reported`. `locus`: `L`.
Output `{"expected": [...], "reported": [...], "determinate": bool}` or `null` when no DRB1 key.

### 3c. Response
```json
{"release": "3.65.0", "valid": <no error issues>, "loci": {<input key>: [rows]},
 "issues": [...], "counts": {"error": n, "warning": n, "info": n},
 "profile": {"b_leader_genotype": ..., "c_kir_ligand_genotype": ..., "kir_ligands_present": [...],
             "kir_ligand_status": ...},
 "drb345": {...} | null, "attribution": "..."}
```
Metering units = total reported strings.

## 4. `POST /v1/compat` — donor/recipient immunogenetic compatibility

Body: `{"recipient": typing, "donor": typing}`; each validated as in §3 (side names `recipient`,
`donor`). Run §3 on each side.

- `b_leader`:
  - `recipient`, `donor`: each side's `b_leader_genotype`.
  - `b_mismatches`: null unless both sides have a B key with 1–2 rows all having allele_2field !=
    UNRESOLVABLE. Else multiset match of the allele_2field lists: `matched` = size of multiset
    intersection; `slots = max(len R, len D)`; `b_mismatches = slots - matched`.
  - `leader_match`: null unless `b_mismatches == 1`, both sides have exactly 2 B rows, and exactly
    one recipient row and one donor row are left unmatched after removing the multiset
    intersection (remove the first equal occurrence, in list order). Then true iff both unmatched
    rows' `ligands.leader_21` are in {M,T} and equal; false iff both in {M,T} and different; else null.
  - `rule`: exact string `"Petersdorf 2020 (NEJM): for a single HLA-B mismatch, leader-matched when the mismatched recipient and donor HLA-B alleles share the -21 M/T leader residue. Decision support only; not a medical device."`
- `kir_ligands`: class of a ligand: `Bw4`,`Bw4-80I`,`Bw4-80T` → `Bw4`; `C1` → `C1`; `C2` → `C2`.
  - `recipient`, `donor`: sorted distinct classes from each side's `kir_ligands_present`.
  - `missing_in_recipient`: sorted donor classes not in recipient (GvH-direction ligand incompatibility).
  - `missing_in_donor`: sorted recipient classes not in donor (HvG direction).
  - `status`: `complete` iff both sides' `kir_ligand_status` are `complete`, else `incomplete`.
  - `rule`: exact string `"Ligand-ligand model: a KIR ligand class (C1, C2, Bw4) present in one party and absent in the other. Requires complete A, B and C typing. Decision support only; not a medical device."`
- `recipient_valid`, `donor_valid`: each side's `valid`.
- `issues`: `{"recipient": <side issues>, "donor": <side issues>}`.

Response key order: `release, b_leader, kir_ligands, recipient_valid, donor_valid, issues, attribution`.
Units = total reported strings on both sides.

## 5. `POST /v1/glstring` — GL String validation and normalization

Body: `{"gl": string}`. 422 `gl must be a non-empty string` if not a string or empty after strip;
422 `gl must be at most 100000 characters` if longer. Parse `s = gl.strip()`.

Grammar (lowest to highest precedence): `^` locus blocks → `|` genotype alternatives → `+`
genotype → `~` haplotype → `/` allele list → allele token. Split with plain string split at each
level. Each allele token is `.strip()`ped.

If more than 5000 allele tokens → 422 `gl must contain at most 5000 alleles`.

Allele token `t` (after strip); `base = t[4:]` if `t` starts with `HLA-` else `t`:
- `t == ""` → issue `empty_element` (error), detail `empty element in '{enclosing ~ haplotype text or / list text as split}'`
  (use the text of the immediately enclosing `/`-list before splitting). Not added to alleles.
- any whitespace inside `t` → `whitespace_in_name` (error) `'{t}' contains whitespace`; status `unresolvable`.
- `ref.is_group_name(base)` → status `group`, current_name = base.
- else `name, flags = resolve_name(ref, base)`: None → `unresolvable`; `deprecated_name` in flags → `renamed`; else `valid`.
- locus = canonical locus as in §3 (from current name if resolvable, else regex on base, `Cw`→`C`; group names: locus = text before `*`).

Allele issues: `unresolvable_allele` (error) `'{t}' is not a name in release {release}`;
`renamed_allele` (warning) `'{t}' is outdated; current name is {current_name}`. Emitted at every
occurrence, in reading order.

Structure issues (emitted right after the allele issues of the element they concern, innermost first):
- `/` list with >1 distinct non-null locus → `mixed_locus_allele_list` (error): `'{list text}' mixes loci {sorted loci joined ', '}`.
- `~` haplotype where some non-null locus appears in two of its `/` lists → `haplotype_repeats_locus` (error): `'{haplotype text}' repeats locus {locus}` (first repeated locus in sorted order).
- `+` genotype with more than 2 haplotypes → `more_than_two_haplotypes` (warning): `'{genotype text}' has {n} haplotypes`.
- `+` genotype whose haplotypes' locus sets differ → `genotype_loci_differ` (error): `'{genotype text}' pairs different loci`.
- `|` alternatives whose genotype locus sets differ → `genotype_list_loci_differ` (warning): `'{block text}' lists genotypes over different loci`.
- A locus appearing in more than one `^` block → `locus_repeated_across_blocks` (warning): `locus {L} appears in more than one ^ block` (one issue per locus, sorted, after everything else).
Locus set of an element = set of non-null loci of all allele tokens inside it. "text" is the element's text exactly as produced by the split (unstripped).

Normalized GL: rebuild with the same operators and no added spaces; each allele token replaced by:
`renamed` → (`HLA-` if t had it) + current_name; otherwise the stripped token `t`. Empty tokens stay empty.

Response:
```json
{"release": "3.65.0", "valid": <no error issues>, "normalized_gl": "...", "changed": <normalized != s>,
 "loci": [sorted distinct non-null loci], "alleles": [{"token": t, "status": ..., "current_name": ...|null, "locus": ...|null}],
 "issues": [{"severity": ..., "code": ..., "detail": ...}], "counts": {"error": n, "warning": n},
 "attribution": "..."}
```
`alleles`: one entry per distinct non-empty token `t`, first-appearance order. Units = allele token count.

## 6. Surfaces
- Python FastAPI app: the three POST routes; `/v1/allele` gains `ligands`.
- Edge Worker: same routes; `handlers.js` validation shared with MCP.
- MCP tools (remote `edge/src/mcp.js` and stdio `sci_envs/mcp_server.py`): `check_typing {typing}`,
  `donor_compat {recipient, donor}`, `validate_gl_string {gl}`. Descriptions must say
  "decision support only; not a medical device" for `donor_compat`.
- Docs: `edge/src/docs.js` (HTML docs + OpenAPI), README "HLA-Verify" section, `skills/hla-verify/`.

## 7. Acceptance
- `pytest -q` green (including new `tests/test_lab.py` covering every issue code, every ligand
  value above, B*46:01 C1, a null allele, a 2-field ambiguity, DRB345 cases, Petersdorf single
  mismatch true/false, a GL string with each structure issue).
- `python -m sci_envs.service.edge_export` then `python edge/test/gen_fixtures.py` then
  `cd edge && node --test` green, with ≥300 typing/check, ≥150 compat, ≥200 glstring fixtures.
- No sequences in any response or shard.
