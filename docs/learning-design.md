# Learning design

A personal vocabulary app for productive recall. French is the first target language; Italian is the default prompt language. Prompt language, target language, and interface locale are separate settings.

See the [repository overview](../README.md), [catalogue guide](catalogue.md), and [development guide](development.md) for implementation, content, and local setup.

## The activity: teach, then recall

New vocabulary is taught before it is tested. There is no guess or pretest screen.

1. **Teach.** Show the French headword, its Italian meaning, grammatical label, a short explanation when needed, and a clearly labelled usage example when available. Play audio; offer replay. The learner continues after studying the entry.
2. **Return to the queue.** Persist the teaching completion. Other words and due reviews can fill the gap before first recall.
3. **Recall.** Show the Italian meaning, with separate context when necessary. Ask for the French word or taught expression, not a literal translation of the entire definition.
4. **Feedback.** Show the correct answer and relevant explanation after an incorrect response.
5. **Schedule.** Feed actual recall ratings to FSRS. Teaching is not a successful recall and receives no rating.

The first recall becomes eligible 60 seconds after teaching completion. This is an explicit introductory delay, not a scientifically optimal interval or a second long-term scheduler. It survives reloads. When there is nothing else to do, show the honest waiting state instead of testing the word immediately.

After the first rated recall, FSRS controls learning steps and longer-term reviews.

### Meaning is not an instruction to translate a whole phrase

For example, the lesson for **être** shows:

- Headword: **être**
- Italian meaning: **essere**
- Grammar: **verbo · infinito**
- Context: **Per indicare dove si trova qualcuno o qualcosa.**
- Usage: **être à la maison — essere a casa**
- Explanation: the learner is learning the infinitive, not the whole example.

Recall shows **essere**, its grammatical label and clarifying context, and an instruction to write only the French word. It does not show the French headword, usage example, or teaching explanation.

A one-word Italian equivalent is not always possible. A concise definition can still serve as the meaning cue, but the interface must identify it as a meaning, not imply that every word in the definition belongs in the answer.

## What is learned and scheduled

- Words and their inflected forms belong to the same vocabulary model. Irregularity is an annotation, not a third kind of learning content.
- A particular meaning-to-word/form memory gets its own FSRS history. Learning an infinitive does not mark its conjugations or derivatives learned.
- Inflection and derivation are distinct relationships. Family membership organises vocabulary; it does not supply a shared mastery score.
- Frequency evidence is separate from the curriculum. The curriculum decides what to introduce and in what order; FSRS decides when to review an introduced memory.
- The core activity remains meaning-to-L2 production. Sentence-writing exercises and grammar-rule scheduling are not implemented.

A sentence error does not reliably reveal which underlying word, gender fact, or grammar rule failed. We do not infer a general grammar-memory rating from such errors.

## Current family curriculum

The local dogfood resource contains 1,000 conservatively grouped families, 1,049 lemma members, and 12,498 observed form records with subtitle frequencies. The curriculum teaches the 1,049 lemma targets and 35 selected present-tense forms.

Family selection has an explicit policy; these are not claimed to be exhaustive derivational families. A selected form follows its lemma with at least 19 intervening targets. That is an editorial ordering choice, not evidence that the prerequisite is mastered.

Teaching presentation is versioned separately from immutable historical cues and answers. Dictionary-style copy can clarify the same selected meaning without renaming words or resetting progress. A genuine change of meaning still requires an explicit new identity and progress policy.

The current presentation includes authored clarifications for frequent entries, including être. Other entries separate their existing parenthetical qualifiers from the main meaning where possible. That mechanical separation is not an independent review of the whole curriculum. Content remains draft until reviewed.

## Evidence and limits

1. **Train productive recall.** Typing an L2 word from a meaning cue practises the production skill this app targets. Evidence does not establish universal superiority over every alternative task.
2. **Give a clear introduction.** A brief explanation and worked example can make a meaning or pattern explicit. The app then practises recall with feedback rather than requiring a guess at an unknown word.
3. **Pretesting is retired.** Evidence for pretesting varies by material and test. The product now uses teach-first; historical guesses remain readable only to preserve old progress and retry old queued requests.
4. **Space recall.** FSRS supplies post-recall scheduling. The fixed initial 60-second gap is a product choice before FSRS has received its first rating.
5. **Use frequency without confusing it with teaching order.** Prefer useful, mixed vocabulary. Family membership does not require introducing every member together.
6. **Provide audio.** Browser speech synthesis supplies pronunciation with a visible replay control. If audio is unavailable, the learner can continue with text.
7. **Distinguish formulaic expressions from arbitrary examples.** A selected chunk may be a vocabulary target. A sentence illustrating a word is not automatically a new FSRS item.

The [catalogue evidence summary](catalogue.md#cue-and-learning-evidence) preserves research sources and their limitations.

## Scheduling and resume

`packages/spaced-repetition/src/select-next-step.ts` defines queue precedence. Actual due learning cards, new-word allowance, eligible reviews, and introductory recalls are interleaved without inventing extra workload.

- New words open directly in teaching. Merely viewing an entry does not consume the daily allowance; completing its teaching does.
- Completed teaching persists its first-recall eligibility. Reloading does not show the same introduction again or erase the delay.
- A legacy guess without a rated recall is not evidence that teaching completed. Show the lesson once, without charging the original introduction against the allowance a second time.
- Rated cards retain their scheduling state and history.
- Reviews use calendar study days and the configured rollover. A Review card rated today is not asked again before the next study day, even on a 25-hour day.
- Limited learning-card look-ahead may fill gaps after other useful work. It does not pull mature reviews back from future days or bypass the first-recall delay.
- If another card is coming later today, show a waiting state and resume when eligible. If nothing remains today, show completion.

FSRS cannot rate reading. The first post-teaching recall is rating number one. Teaching completion is stored separately from recall attempts; no fake guess or fabricated `Again` is inserted.

## Grading

Typing determines spelling correctness. The learner selects how easily a correct answer came; the same buttons submit the response.

| Situation          | Stored result                                    |
| ------------------ | ------------------------------------------------ |
| Teaching completed | Unrated teaching event                           |
| Correct recall     | Hard, Good, or Easy, as offered by the scheduler |
| Incorrect recall   | Again; show the answer and feedback              |

Enter submits Good. Effort is selected before revealing the answer. Response latency is recorded but does not determine the grade.

### Answer comparison

Orthography is graded; typography is normalised.

- Missing accents, wrong letters, and wrong word order count as errors.
- Case, surrounding whitespace, equivalent Unicode composition, apostrophe variants, and repeated internal whitespace are normalised.
- `œ` and `oe` are treated as equivalent.
- Terminal `?`, `!`, and `.` are ignored for grading but retained in content and audio.

Alternative correct synonyms are a separate content/grading problem. Exact comparison must not silently claim that producing a synonym proves recall of the intended target.

## Persistence and testing

D1/SQLite stores the catalogue, immutable teaching completions, append-only historical attempts, and per-user FSRS state. A teaching completion and its first-recall eligibility are persisted transactionally. A recall attempt and its card update are committed together.

Stable request IDs make retries idempotent. Revision guards reject stale writes. A user-scoped browser outbox preserves unsynchronised work and blocks further local answers after a storage failure. Clearing browser storage before synchronisation can still lose unsaved work.

Engine tests cover introduction, first-recall timing, resume, grading, queue precedence, and legacy history. Simulator and property tests exercise serialised commands through the public engine/server contracts. Database tests cover migrations, transactions, retries, ownership, and append-only history. UI tests cover teaching without a guess, dictionary presentation, answer-free recall, and recovery.

## Remaining work

- Independently review curriculum meanings, cues, examples, and accepted alternatives.
- Expand form coverage based on useful production targets, not every mechanically generated conjugation.
- Improve audio quality and language controls independently of the core flow.
- Design sentence-writing practice and its revisit policy before introducing grammar FSRS grades.
- Retrain FSRS only when enough real recall history exists.

## Conventions

- Italian is the default interface and prompt language; code and documentation use English.
- Mobile-first, with the same clear production flow on desktop.
- Teaching explanations and examples never appear as answer-bearing recall hints.
- Existing progress is preserved; no local reset or remote deployment is implicit in a UI or curriculum change.
