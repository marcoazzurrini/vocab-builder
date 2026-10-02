# Vocabulary catalogue

This is the consolidated record of the vocabulary-source research, cue decisions, data format, database design, implementation, and remaining work. It supersedes the earlier individual research notes. The learning loop and scheduler remain documented in [learning-design.md](learning-design.md); deployment is documented in [development.md](development.md).

## Scope and decisions

- French first, with Italian prompts. Prompt language is separate from target language and interface locale.
- The current dogfood batch counts **1,000 families**, containing **1,049 lemmas** and **12,498 observed forms**. Its first curriculum teaches **1,084 targets**: the lemma members plus 35 selected present-tense forms. The previous 1,000-lemma package remains as a compatible input, not the current family count. The earlier 3,000 figure was a scale estimate, never a permanent ceiling.
- Select candidates using subtitle frequency, with explicit exclusions for unsuitable grammatical uses and known source anomalies.
- Link related lemmas without treating family membership as evidence that every member is mastered. Family coverage and lemma coverage are separate counts.
- Keep one meaning-to-L2 production activity. Introduction, reveal, typed recall, orthographic comparison and FSRS behavior remain unchanged.
- No saved-word collection feature or speculative domain taxonomy is required. Named source-backed lists can share entries.
- Imports default to local D1. Production family imports require explicit `--remote` and separate authorization; they are not part of automatic code deployments.
- Preserve existing word IDs, cards, attempts, authentication records and user settings. No progress reset accompanies the new catalogue.

## Minimum information

The JSON import package and SQL database represent the same information, but do not have identical shapes.

| Information | Purpose |
| --- | --- |
| Lexical entry ID, language, text, word/chunk kind | Stable identity independent of rank and prompt wording |
| Source ID, version, key and archive hash | Reproducible extraction and traceable corrections |
| Frequency observations and rank | Default order for introducing new entries |
| Sense ID, description and grammatical use | Identify exactly what the learner is being asked to produce |
| Prompt ID, language, version, cue and expected answer | A specific production task with an auditable identity |
| Review state and cue provenance | Distinguish generated drafts from reviewed teaching material |
| List membership and position | Select and order entries without duplicating their identities |
| Optional morphology/family evidence | Relate words without merging their learning histories |

Images, audio assets, additional examples, fine-grained topics, CEFR labels, and sophisticated cue selection can be added later. Do not fabricate them to fill fields. Retaining source and identity information is more important than populating every annotation.

### Words, meanings, prompts

One spelling can have multiple meanings: English `bank` can mean a financial institution or a river edge. Italian `banca` is a cue for the former; `sponda del fiume` is a cue for the latter. They are different associations even though their expected English spelling is identical. Teach only selected useful meanings, not automatically every dictionary sense.

Part of speech describes a grammatical use, not an immutable property of spelling. `clean` can be an adjective or a verb. Frequency data may or may not distinguish those uses; never invent that split.

Language-pair relationships are separate from word families. Italian `tempo` can correspond to English `time` or `weather`; that does not make the English words derivational relatives. Likewise, `start` and `begin` may both answer a cue correctly. A future alternative-answer policy must distinguish a valid alternative from evidence of recalling the intended target.

## Family resource and separate curriculum

`packages/database/scripts/catalogue/families.ts` selects from the complete eligible Lexique lemma pool, groups inflections under their lemma, and applies explicit conservative editorial derivation links. Unknown derivational relationships are not invented: a singleton lemma with its inflections is a family under this policy. Family frequency is the sum of eligible member-lemma frequencies, not a sum of lemma totals plus their inflections. These are the most frequent families under this defined eligibility/grouping policy, not a claim of exhaustive dictionary family analysis.

- `family-resource.json`: machine-built family membership/ranks, lemma frequencies, and individual form observations (text, part of speech, gender, number, verb annotation, frequency, source). A spelling may have multiple grammatical observations; they are not silently collapsed or assigned the lemma's frequency.
- `curation-families.json`: editorial Italian cues for the 49 additional lemma members needed to reach 1,000 families.
- `curriculum-fr-it.json`: separate, versioned teaching targets and their introduction positions, cue identities, explanations, family/form references, and prerequisites. The 35 selected forms and their cues are maintained in `curriculum.ts`; they do not teach every possible conjugation.

The initial curriculum is frequency-led, with selected forms introduced after their base lemma and at least 19 intervening targets. This is an editorial policy, not corpus frequency and not a mastery gate. Derivatives are interleaved by their own lemma frequency rather than introduced in consecutive family blocks. A resource observation does not automatically create a recall card.

Each selected word/form keeps its own FSRS history. Family membership provides an association with those histories, not a family-wide stability or learned score. The existing runtime word projection remains the compatibility boundary; selected forms receive separate stable prompt IDs and cannot inherit their lemma's card. Old introduced words remain reviewable even when no longer selected for new introductions.

Migration `0005_family_curriculum.sql` adds `catalogue_forms`, `catalogue_family_ranks`, `catalogue_curricula`, and `catalogue_curriculum_steps`. Foreign keys and immutability guards protect the resource observations and published curricula. Object-key order is ignored when hashing curriculum content; lesson-array order remains meaningful. Exact reimports are idempotent; substantive edits require a new version, not rewriting live prompt meaning.

The activity now starts with teaching, not guessing. Dictionary-style presentation separates the French headword, Italian meaning, grammar, context, explanation, and labelled usage example. Recall contains only the meaning and non-answer context, with an explicit request for the word or taught expression. Explanations and examples appear only during teaching and feedback. Per-word/form grading and the FSRS algorithm are unchanged; teaching itself is unrated. Sentence writing, grammar-rule scheduling, and family mastery inference remain outside this pilot.

Migration `0006_teach_first.sql` adds durable, append-only teaching completions and first-recall eligibility while preserving historical guesses, recalls, and cards. Migration `0007_dictionary_presentations.sql` adds versioned `catalogue_presentations`, linked to existing prompts without rewriting their historical cue or answer. `presentations.ts` supplies separate meaning/context fields and authored clarifications for frequent entries, including **être: essere**, with **être à la maison / essere a casa** as a labelled example—not the answer to memorise. This is improved draft teaching copy, not independent review of every entry. Reimporting the family curriculum installs it in the selected database; substantive presentation changes require a new presentation version.

Presentation version 2 replaces 282 opaque lemma paraphrases with direct Italian equivalents in `packages/database/scripts/catalogue/meaning-cues.json`, and corrects the selected `va` form to Italian `va` while retaining its person and tense. For example, French `dire` now uses Italian `dire`, not `esprimere qualcosa`. Identical French/Italian spellings are valid translations. Short context qualifiers distinguish selected senses; gender and number requirements remain in grammar. Historical curriculum cues, prompt IDs, and learning records are unchanged. The correction map participates in the presentation source hash. Install these corrections with the family importer; deploying the app alone does not update D1 content.

Both inherited and new machine-authored cues remain drafts unless explicitly reviewed. `--allow-drafts` acknowledges personal evaluation of unreviewed content, including an explicitly authorized production import. It is not independent linguistic review, and valid synonyms can still fail the existing exact-target grader. Corrections to published cues need versioning and a deliberate history policy.

## Legacy JSON package, version 1

Executable validation lives in `packages/database/scripts/catalogue/contract.ts`. The generated import package is `packages/database/scripts/catalogue/fr-it-1000.json`.

The root includes `schema_version`, catalogue ID/title, target and prompt languages, ranking policy, lexical source, cue source, and entries. Each entry contains its source key, selected canonical target, eligible frequency rank, per-million observations per source POS, total eligible frequency, inflected forms, optional pronunciation/gender/morphology, frequency warnings, and one selected sense with one prompt.

The initial format deliberately handles one chosen sense/prompt per lemma. The SQL model supports multiple senses and prompt languages. Expanding the import format to multiple senses is a future schema-version change, not grounds for creating 1,000 indistinguishable word copies now.

- IDs are deterministic and do not depend on Italian wording or frequency rank.
- Duplicate IDs, duplicate targets, duplicate ranks, mismatched languages, target-leaking identical cues, inconsistent totals and non-descending frequency order fail validation.
- Version 1 uses the canonical target as the expected answer. It does **not** yet implement synonym-aware grading or alternative correct answers.
- Review state is `machine_draft` or `reviewed`. The generated pilot remains `machine_draft`.
- Requiring `--allow-drafts` is intentional. Passing validation proves structural consistency, not linguistic correctness.

## Database model and compatibility

`packages/database/src/catalogue-schema.ts`, `packages/database/src/schema.ts` and migration `0004_catalogue_foundation.sql` add:

- `catalogue_sources`: immutable named source versions and hashes.
- `lexical_entries`: language-specific words/expressions and source annotations.
- `catalogue_senses`: meaning and grammatical-use identity.
- `catalogue_prompts`: immutable prompt versions linked to senses and runtime word IDs.
- `catalogue_frequencies`: source-specific lemma/POS frequency observations.
- `catalogue_lists` and `catalogue_list_members`: default collection and ordered membership for a target/prompt-language pair.
- `catalogue_families` and `catalogue_family_members`: provenance-labelled family relationships.
- `settings.prompt_language`: configurable independently of the existing target-language setting and UI locale.

The existing `words` table remains the production-prompt projection consumed by the scheduler. Existing word IDs remain intact, so append-only attempts and cards do not need to be rebuilt. Newly generated prompts use their stable prompt IDs as projection IDs. Exact existing language/text/cue/prompt-language matches can reuse the existing projection; its historical reveal payload is retained rather than silently rewritten.

The uniqueness key for legacy word imports now includes prompt language. It no longer merges equivalent-looking Italian and English cues accidentally.

Prompt content, source versions and sense identity have database immutability guards. Identical reimports are allowed. Reinterpreting an existing sense or changing a published cue under the same prompt version is rejected; it requires an explicit new identity/version and, where appropriate, an explicit progress-transition policy. Automatic transfer of progress across changed cues or prompt languages is not implemented.

Activating a new default list limits new introductions to its membership, while previously introduced legacy targets remain available for review. Staging alone does not expose newly created draft projections after the import completes. Shared existing words can receive updated ranks and dictionary presentations before default-list activation; staging is not completely invisible. Switching prompt language does not rewrite or discard the old learning history.

The server supports saving prompt language; a settings UI control is deferred. The default remains Italian. The catalogue importer defaults to local D1; only the family importer supports explicit `--remote`.

## French extraction

### Pinned Lexique 4 source

- Website: <https://www.lexique.org/>
- Archive: <https://www.lexique.org/databases/Lexique400/Lexique400.zip>
- Archive SHA-256: `8ed5a64373ae798f0485a2a35848c09286b6694c6859abeaab6806594c046993`
- TSV archive member: `Lexique4/Lexique4.tsv`
- TSV SHA-256: `fe333b4f9e1797f23922d5863cde28635ee13685813af0f9b4b4b9f7d4610a5a`
- Downloaded snapshot: 189,863 rows and 65,165 distinct nonempty lemma strings.
- Frequency corpus: 316 million subtitle-word occurrences from 65,317 documents.

These counts have different units. The roughly 140,000 forms in older Lexique 3 were not a 140,000-token corpus. Corpus size includes repetitions; vocabulary entry count does not. Subtitle frequency is useful evidence, not a guarantee of conversational or pedagogical priority.

Lexique supplies the candidate lemmas, frequencies and forms used to construct our selected word families; Italian cues and teaching decisions are project additions. Source credits and licence information are consolidated in [third-party notices](../apps/web/public/third-party-notices.txt), which also documents the archive/website licence discrepancy.

### Deterministic selection policy

Implementation: `packages/database/scripts/catalogue/extract.ts`.

1. Download into ignored `.cache/catalogue/`, verify the pinned archive hash, and extract the TSV. A changed archive fails until explicitly audited.
2. Preserve accents and NFC spelling. Require the needed headers and finite, nonnegative frequencies.
3. Consider `NOM`, `VER`, `ADJ`, `ADV`, and `ADJ:num` uses. Do not include article, pronoun, preposition, conjunction, auxiliary or determiner counts in the selected content-use frequency.
4. Apply an explicit exception set for grammatical particles and observed annotation/homograph anomalies. The set is in code, not a hidden model decision. It currently includes `upas`, `ca`, `rob`, `déesse`, `garce`, `garçonne`, and `cieux` as ranking exclusions, not claims that these spellings are universally invalid French words.
5. Take the published `12_FreqLemme` value from canonical `14_IsLem == 1` rows once per lemma/POS. Never add that repeated total once per inflection. Conflicting canonical observations fail.
6. Sum the retained POS observations once per lemma. Keep the individual observations and flag disagreements with inflection-row totals. Canonical-row selection is an explicit resolution policy, **not a verified correction of the upstream corpus**.
7. Sort descending by that sum, then by deterministic Unicode lemma order. Rank after filtering; this is an **eligible-list rank**, not an official Lexique rank or a measured sense frequency.
8. Select 1,000 candidates. Fail rather than silently produce fewer. Keep a selected meaning and an Italian cue for each source lemma.

Pronominal targets such as `se souvenir`, `s'enfuir` and `se moquer` preserve their original source lemma keys while presenting the grammatical target needed for the selected sense.

### Remaining frequency uncertainty

The independent audit found 598 lemma/POS groups with inconsistent repeated lemma totals. Taking a canonical-row value avoids summing duplicates but does not establish that every retained figure is correct. Warnings remain in the generated JSON and SQL annotations. The candidate policy is an auditable pilot, not a certified gold-standard top 1,000.

Source ranks must not be copied onto individual senses and described as separately measured sense frequencies. Family counts must not double-count lemma totals either.

## Italian cue enrichment and families

`curation-1.json` through `curation-4.json` contain model-authored meaning descriptions, Italian cues and optional reveal notes. These are original drafts produced during this implementation, not copied dictionary entries or independently validated translations. `build.ts` combines them with the pinned candidate extraction. Missing or duplicate curation fails the build.

The build does not call a paid model API and does not generate new text during a learning session. Rebuilding the checked-in drafts is deterministic. Model weights, sampling details and a complete independent review were not captured, so the drafts are not presented as a reproducible linguistic benchmark.

Useful subsequent evidence sources were found but **not imported or aligned**:

- FreeDict/WikDict French–Italian: <https://download.freedict.org/dictionaries/fra-ita/2025.11.23/freedict-fra-ita-2025.11.23.src.tar.xz>, SHA-256 `1e4a04f06cbd094c37818a715fc402bfa76af42a5828a1c412fe565e4f151d8e`. Automatically generated dictionary through Wiktionary/DBnary; archive declares CC BY-SA 3.0. Presence of a translation does not establish that it matches the selected teaching sense.
- Italian Wiktionary raw extraction: <https://kaikki.org/itwiktionary/raw-wiktextract-data.jsonl.gz>. Mutable download; pin and retain a specific version before relying on it. Preserve content attribution and licensing separately from extractor software licensing.

Lexique's `30_MorphoBase`, `31_MorphoStruct` and `32_MorphoDecomp` are retained as source annotations. They are not automatically converted into a transitive family graph: missing data, multiple roots, etymological relations and semantic divergence make that unsafe.

A limited set of conservative editorial family links is included by `compile.ts`, explicitly labelled model-authored. It is neither a complete family taxonomy nor an independently validated one. Family membership never merges cards or grants mastery of derivatives.

## Cue and learning evidence

### Established direction and limits

Meaning-to-L2 retrieval is a defensible core activity for productive vocabulary. Its benefits depend on what the learner practices and how performance is tested; it is not proof of overall proficiency or superiority for every linguistic item. The app retains the existing activity rather than introducing a suite of required exercise types.

Use the shortest cue that identifies the intended meaning:

1. A familiar L1 equivalent when adequate.
2. A small disambiguation when necessary.
3. A definition when no convenient familiar label exists.
4. A picture where it identifies the intended concept clearly, not simply because the target is a noun.
5. Additional explanation or examples when useful, generally at introduction/reveal. Do not leak the target into the retrieval cue.

Supporting reviews and experiments include [Webb (2009)](https://doi.org/10.1177/0033688209343854), the [intentional-learning meta-analysis](https://doi.org/10.1111/modl.12671), [Gyllstad et al. on definitions](https://doi.org/10.1111/lang.12527), [learning direction](https://doi.org/10.1017/S0272263121000346), [Barcroft on initial form learning](https://doi.org/10.1191/0267658304sr233oa), and [Webb on reading/writing and time allocation](https://doi.org/10.1017/S0272263105050023). These do not establish a proficiency threshold where L1 cues should universally be replaced by L2 definitions. Mandatory sentence generation can compete with initial word-form learning and must be evaluated against its time cost, not only raw test gains.

These are editorial heuristics, not experimentally optimized cue rules. Function-word exercises are a separate issue: an isolated translation of an article often fails to specify its grammatical use. This pilot excludes pure grammatical targets rather than expanding the app into a grammar tutor.

### Pre-guessing

Evidence for guessing before instruction varies with material, answer format, test and time allocation. Benefit per minute for this app's free-response guess step has not been established. The current implementation retires the initial guess and teaches before testing. Completed teaching receives no FSRS rating; the first actual recall does. Historical guess events remain supported for progress preservation and pending-request replay. Relevant evidence includes the [prequestioning review](https://doi.org/10.3758/s13423-023-02353-8), [vocabulary testing study](https://doi.org/10.3758/s13421-021-01254-2), [learning from errors](https://doi.org/10.1037/xap0000145), and [retention-duration evidence](https://doi.org/10.1037/mac0000085). Recognition benefits, productive-recall benefits and advantages per minute are different outcomes; a positive result on one does not establish the others.

### Translation ambiguity and instruction

- Degani & Tokowicz (2010), [Ambiguous words are harder to learn](https://doi.org/10.1017/S1366728909990411): one-to-many translation mappings can impede initial learning. Same-meaning alternatives and distinct meanings are not interchangeable problems.
- Degani, Tseng & Tokowicz (2014), [Together or apart](https://doi.org/10.1017/S1366728913000837): consecutive introduction of competing translations in one session outperformed separate introductions in that experiment, with one- and three-week testing. This is not evidence against spaced reviews or a universal schedule for all meanings of one foreign spelling.
- Tokowicz, Rice & Ekves (2023), [Simultaneous vs. consecutive presentation](https://doi.org/10.1177/02676583221090069): consecutive presentation beat simultaneous display in a different mapping/task design. More information on one screen is not automatically better.
- Laufer & Girsai (2008), [contrastive instruction](https://doi.org/10.1093/applin/amn018), and [Jahangard's 2022 replication](https://doi.org/10.61871/mj.v46n3-9): support investigating explicit comparisons, with the replication's advantage limited to delayed active recall rather than every outcome.

For example, computing `deadlock` involves circular waiting; `stall` need not. Briefly explaining that difference can make the ordinary production cue more precise. The proposed app-specific contrast format has not itself been experimentally validated.

### Programming-language transfer analogy

[Shrestha et al. (2020)](https://doi.org/10.1145/3377811.3380352) found prior-language interference in a deliberately selected set of cross-language programming questions; it does not estimate the proportion of all learning difficulty caused by transfer. [Tshukudu & Jensen (2020)](https://doi.org/10.1145/3416465.3416475) found benefits from explicit Python/Java comparison on misleading similarities in a controlled experiment, but the treatment bundled explanations and activities and the controlled test was immediate. The analogy motivates targeted distinctions, not a claim that one method universally wins.

## Other source research retained for future work

### French supplements

- [FLELex](https://cental.uclouvain.be/cefrlex/flelex/): frequencies in learner textbooks/readers and expression candidates; not general-population frequency.
- [frTenTen](https://www.sketchengine.eu/frtenten-french-corpus/): large web corpus and tools for frequency, collocations and multiword sequences. Web size alone does not establish conversational usefulness.
- [CEFC/ORFÉO](https://repository.ortolang.fr/api/content/cefc-orfeo/4/documentation/site-orfeo/home/index.html): spoken and written contemporary French, including four million transcribed spoken words, useful for checking subtitle bias.

Use existing processed resources first. Build raw-corpus analysis only when a specific need, such as comparable chunk counts or a missing domain, warrants that work.

### English resources

- [NGSL directory](https://www.newgeneralservicelist.com/word-lists): curated core and specialist selections. Its inflection groups are narrower than broad derivational families; that does not make them unsuitable learning targets.
- [NGSL 31k workbook](https://www.newgeneralservicelist.com/s/NGSLwithSFI-31K.xlsx): 31,240 populated lemma rows in the audited snapshot, not 31,000 ready-made lessons.
- NGSL-GR extends the core to approximately 5,000 entries; it does not contribute 5,000 disjoint additions. The ten downloaded lists yielded 7,593 distinct normalized headword labels in the prior audit, not 7,593 meanings or independent family units. Treat that as a historical snapshot, not a build input or permanent count.
- [Business Service List](https://www.newgeneralservicelist.com/business-service-list) and [New Academic Word List](https://www.newgeneralservicelist.com/new-academic-word-list): documented corpus-based collections. An equivalent import-ready computing list was not verified.
- [LancsLex](https://lancslex.lancs.ac.uk/): BNC2014 word/lemma and two-/three-word frequency evidence. Frequent sequences still need linguistic selection. Its CC BY-NC-ND licence permits private noncommercial adaptations but restricts sharing adaptations.
- [Martinez thesis](https://repository.nottingham.ac.uk/server/api/core/bitstreams/400141c4-21d1-455d-8e28-a140d826d8f2/content): counted BNC words grouped using Nation family definitions and integrated formulaic expressions. A 600-entry combined sample is available, not the complete matching ranked file. Published ranks differ between tables; do not invent missing family ranks from alphabetical frequency bands.
- [English Vocabulary Profile](https://englishprofile.org/?menu=english-vocabulary-profile) and [Oxford 3000/5000](https://www.oxfordlearnersdictionaries.com/about/wordlists/oxford3000-5000): language-specific CEFR mappings, with access/reuse conditions. CEFR itself does not prescribe a universal word quota; completing cards does not certify a proficiency level. No CEFR feature is required for this implementation.

## Commands and local safety

```sh
# Requires Bun and unzip; downloads only if the pinned archive is absent.
bun run catalogue:extract
bun run catalogue:build
bun run catalogue:families

# Back up the local database before applying the migration.
# Run from apps/web; never add --remote for this task.
bun run wrangler d1 export DB --local --output .wrangler/before-catalogue-migration.sql

# From the repository root:
bun run db:migrate
bun run catalogue:import:families --allow-drafts --activate
```

The checked-in family resource and curriculum can be imported without rerunning extraction or downloading Lexique. `catalogue:import` remains available for the previous lemma package; use `catalogue:import:families` for the dogfood curriculum.

The importer creates another local SQL backup before its transactional D1 batch, compares card/attempt counts before and after, and reports list membership/family totals. Reimporting the same package is supported. The explicit draft flag acknowledges evaluation of drafts, not a human-review claim. It does not itself authorize a production write.

Original `bun run db:seed` remains available for the legacy fixture. Do not confuse its hand-assigned ranks with Lexique measurements.

## Authorized production family import

Code deployments and catalogue data imports are separate operations. Apply the required schema migrations first. Confirm the account and D1 binding in `apps/web/wrangler.jsonc` before running:

```sh
# Explicitly authorized production operation; default remains local without --remote.
bun run catalogue:import:families --remote --allow-drafts --activate
```

The remote importer exports production D1 into `apps/web/.wrangler/catalogue-backups/`, a private ignored directory. Backups contain authentication and learning data; do not commit or share them. It never copies the local database into production.

Before writing, it rehearses the compiled import against that backup in an in-memory SQLite database. Existing word identities and teaching payloads, authentication records, settings, and learning history must remain unchanged. Only runtime frequency ranks may change. Constraint conflicts fail rather than replacing or deleting existing records.

The importer stages one SQL file, then verifies resource and curriculum hashes, 1,000 families, 1,049 lemmas, 12,498 forms, 1,084 targets and presentations, 35 selected forms, and foreign keys. History counts may increase during concurrent practice but must not decrease. Only successful verification permits the separate default-list activation. Reimporting the same version is safe; changed published content requires a new version.

Wrangler's remote file import temporarily blocks database requests and rolls back that file if import fails. Do not split the file into independently committed batches. A later verification failure leaves activation undone, but a successfully staged file remains installed. Do not automatically restore the full backup: that could erase concurrent learning or authentication changes. Investigate and retry the same resource or deliberately select the previous default list.

The content remains `machine_draft`, with independent linguistic review and accepted-alternative grading still outstanding.

## Production activation — 2026-09-30

- `fr-it-families-1000-curriculum-v1` is active in production for French targets with Italian prompts.
- Verified 1,000 families, 1,049 lemmas, 12,498 observed forms, and 1,084 teaching targets/presentations, including 35 selected forms.
- Exported the production backup and successfully rehearsed the import before writing. Existing learning-history counts were unchanged; all 50 original word identities and payloads were preserved, with 16 exact matches reused. Production now stores 1,118 word projections in total, including retained legacy entries.
- Independent post-import queries confirmed the active list and no foreign-key violations. The production site returned HTTP 200.
- Full CI passed with 842 tests. All 1,084 catalogue prompts remain `machine_draft`; this deployment does not imply independent linguistic review.

## Historical family dogfood local activation

- `bun run check` passed with 717 tests across the workspace, including migration, curriculum, per-form FSRS persistence, and exposure/feedback-only explanation coverage. `bun run build` passed.
- A repeated family import activated `fr-it-families-1000-curriculum-v1` successfully without changing card or attempt counts.
- Migration `0005_family_curriculum.sql` and the family curriculum are installed in the local database only. No remote migration or deployment was performed.
- The local resource contains 1,000 ranked families and 12,498 form observations. The curriculum contains 1,084 production targets covering 1,049 lemmas and 35 additional forms.
- A direct local database check reports no foreign-key violations. There were no cards or attempts in this local database when verified; preservation of populated learning history is tested separately.
- Start the app with `bun run dev`, then open the URL printed by Vite. Local setup uses `AUTH_EMAIL_MODE=log`; the sign-in link appears in the development terminal instead of being sent by email.
- The current browser session must finish saving any pending answer before reloading to pick up a newly activated curriculum.

## Historical lemma-pilot verification

- `bun run check` passed: formatting, lint, dependency boundaries, type checks, translation checks, and **707 tests** across the workspace.
- `bun run build` passed.
- Migration `0004_catalogue_foundation.sql` was applied locally after a verified SQL backup. No remote migration or deployment was performed.
- The then-active local list `fr-lexique4-it-1000-v1` contained 1,000 lexical entries, selected senses and Italian prompts. The application repository returned 1,000 eligible words for a fresh French/Italian learner. The family curriculum now supersedes that list for new introductions.
- Two successive imports succeeded with the same membership and identities. Foreign-key checks report no violations.
- The 50 original word IDs and prompt/reveal content remain intact. Sixteen exact matches reuse those IDs; their mutable runtime frequency ranks were refreshed. The other original entries remain stored. The local database had no cards or attempts before import; populated-history preservation is covered separately by integration tests.
- The pilot includes 23 explicitly editorial family groups linking 48 lemmas. That is partial family coverage, not 1,000 verified families.
- All 1,000 new cue records remain labelled `machine_draft`. Local activation is for evaluation, not a claim of reviewed linguistic quality.

## Remaining work and release gates

1. Independently review Italian cues, selected senses and accepted alternatives. Dictionary coverage is not sense alignment; generated labels must remain drafts until reviewed.
2. Resolve or quarantine outstanding source-frequency warnings before claiming an authoritative top 1,000.
3. Expand verified family relationships; maintain separate lemma, sense, family and chunk counts.
4. Add a reviewed French chunk set from compatible measurements. This batch contains lemma targets, not a completed word-and-chunk curriculum; legacy chunks remain in storage.
5. Support multiple selected senses/prompts per JSON entry and explicit progress transitions across prompt revisions when needed.
6. Add alternative-answer semantics only with corresponding grading/history tests. Do not silently grade a valid synonym as evidence of recalling a different target.
7. Add a prompt-language settings control if needed; database/server configurability exists first.
8. Consider images, pre-generated audio and domain/level collections independently, without blocking the basic catalogue.
9. Remote backup, migration, import and deployment require separate authorization and verified content/access conditions.
