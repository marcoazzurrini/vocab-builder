# Session duration and progress: evidence and UX recommendation

## Question and conclusion

How should this vocabulary app communicate how long a practice session will last, especially for learners with ADHD?

The strongest guidance favors a clear expectation before starting, visible orientation during the task, and an unmistakable stopping point. It does **not** establish that a particular progress bar, countdown, or five-minute session is best for adults with ADHD using spaced repetition.

The recommended prototype is a **short, user-controlled practice block with a soft time goal**, not a deadline for answering. A quiet indicator should describe progress through that time goal, not vocabulary mastery or completion of the entire FSRS queue. Five minutes is a starting product hypothesis, not an evidence-based optimum.

The prototype below is now implemented. The evidence supports its rationale, not a claim that this specific interface or duration has been validated with learners.

## What the evidence actually supports

### 1. External time information addresses a plausible ADHD-related difficulty

Metcalfe, McFeaters, and Voyer's 2024 systematic review and meta-analysis analyzed 824 effect sizes and reported a mean time-perception deficit of Hedges' g = 0.688. Age and other moderators mattered. The 824 figure counts effect sizes, not participants or independent trials. [1]

This supports taking time perception seriously when designing the experience. However, laboratory timing findings do not establish which interface works best, and a group-average difference does not describe every person with ADHD. The meta-analysis does not test an FSRS learning app, a progress bar, or five-minute study sessions.

**Design implication:** externalize the expected commitment instead of requiring the learner to infer how long the queue might last. Treat timer presentation as a preference to test, not a universal accommodation.

### 2. Cognitive accessibility guidance directly recommends setting task expectations

W3C's cognitive accessibility pattern says that, before a multi-step task, users should receive an estimate of the effort involved, including “the time it might take.” It also recommends making the distinction between a task being in progress and being complete clear. [2]

A related pattern recommends showing where the user is in a process so someone who becomes distracted can reorient without rereading everything. [3]

These are accessibility design recommendations, not randomized evidence that a specific indicator improves ADHD learning outcomes. They are nevertheless directly relevant to this app's current uncertainty about session length.

**Design implication:** communicate duration before starting and provide one persistent, understandable progress indicator. Distinguish “this practice block is finished,” “nothing is due right now,” and “today's work is finished.”

### 3. Direct adult-ADHD usability evidence favors simplicity, but remains small

Kenter, Schønning, and Inal's MyADHD study used iterative think-aloud usability testing with five adults with ADHD, aged 25–62. Four participants had difficulty processing lengthy text. The researchers shortened or divided text, corrected inconsistent terminology, and made navigation and save feedback clearer. Participants described the layout as calm and friendly. [4]

This was a small formative study of a self-help intervention. It did not compare countdowns with count-up timers, or measure the effect of progress bars on vocabulary retention.

**Design implication:** avoid stacking a timer, percentage, card count, streak, phase count, and performance score around the lesson. Prefer one quiet bar and one readable duration label. Preserve the visible teaching explanation; the indicator should not compete with it.

### 4. Adding a progress bar does not automatically improve completion

Villar, Callegaro, and Yang's meta-analysis covered 32 randomized web-survey experiments. Constant progress indicators did not significantly reduce dropout overall. Fast-to-slow and slow-to-fast indicators produced different outcomes; slow-to-fast indicators increased dropout in the analyzed studies. [5]

These were surveys, not ADHD learning sessions. Their findings do not justify manipulating the speed of a learning progress bar. They do undermine the assumption that adding any bar must help.

**Design implication:** establish what the bar measures before drawing it. Do not start with a denominator that silently grows as FSRS schedules more repetitions. Do not fabricate early progress or imply that finishing a session means a word is mastered.

### 5. Research does not establish one ideal study-block length

Two studies illustrate why a universal Pomodoro claim would be too strong:

- **Biwer et al., 2023:** 87 university students studied for one day using self-regulated breaks, 24-minute study/6-minute break cycles, or 12-minute study/3-minute break cycles. Systematic breaks were associated with better fatigue, distraction, concentration, and motivation measures. There was no group difference in task completion or invested mental effort. [6]
- **Smits, Wenzel, and de Bruin, 2025:** 94 university students compared self-regulated, 25/5 Pomodoro, and Flowtime breaks during a two-hour study session. There were no overall differences in productivity, task completion, or flow. Some fatigue and motivation trajectories favored self-regulation, without overall between-group differences in fatigue or motivation levels. [7]

Neither was an ADHD-specific vocabulary-learning trial, and neither tested a five-minute practice session. They also concern break strategies, not merely displaying a duration estimate.

**Design implication:** offer a sensible, adjustable starting goal instead of presenting five minutes, 25 minutes, or any other duration as scientifically optimal. Allow stopping and continuing without pressure.

### 6. A time goal should not become an answer deadline

WCAG's timing guidance explains that people with cognitive, language, reading, and other disabilities may need additional time. Where content imposes time limits, it provides requirements for turning off, adjusting, or extending them, subject to specified exceptions. [8]

A voluntary practice goal is not inherently the same as a content timeout. The important distinction is whether reaching zero removes functionality, discards an answer, or forces a transition.

This review did not find strong direct evidence that a countdown is always harmful—or always superior—for adults with ADHD in this setting. Unsupported claims such as “ADHD users must never see countdowns” should not become requirements.

**Design implication:** no per-answer deadline, auto-submission, red urgency state, or forced interruption. Let users hide the numeric clock or change the time goal. A quiet remaining-time estimate is a design hypothesis, not a treatment claim.

### 7. Timeboxing has precedent in spaced repetition

Anki's manual documents a configurable timebox that periodically reports how many cards were studied during the chosen interval. Its learn-ahead policy and day boundaries are separate scheduler settings. [9]

This is a relevant product precedent, not proof of the best UX or of benefits for ADHD.

**Design implication:** a practice-block boundary can be separate from the lifetime of the review queue. Do not change FSRS's memory state merely to make a session indicator reach completion.

## Why this app cannot honestly use a simple card-count percentage

At the time of the research, the implementation had several relevant properties:

- `packages/spaced-repetition/src/index.ts` defaults to 15 new words per study day, not 15 interactions per session. The default rollover is 04:00.
- `packages/spaced-repetition/src/teaching-schedule.ts` requires at least 60 seconds after teaching before the first recall. Teaching is not an FSRS rating.
- `packages/spaced-repetition/src/select-next-step.ts` selects from a changing queue. It mixes new teaching, first recalls, due learning, reviews, and bounded learn-ahead. Further answers can create more learning work.
- `packages/spaced-repetition/src/study-session.ts` distinguishes `caughtUp` from `done`; its current statistics are not a session-duration plan.
- `apps/web/src/features/practice/use-practice-session.ts` automatically rebuilds a caught-up session when the next card becomes due. A perceived finish can therefore become more work without an explicit decision to start another block.

Answer latency is already recorded, but it is not yet a clean measure of active session time. It can include time away from a prompt, while time spent on wrong-answer feedback is not represented as a separate answer latency. An accurate ETA would require better measurement rather than blindly averaging existing values.

A progress bar based on initially due cards would mix words, attempts, teaching, and future repetitions. Its endpoint could move after each difficult answer.

## Recommended prototype

### Before starting

Offer one obvious starting action such as **“Start a short session · about 5 minutes.”** Remember the learner's preferred duration. Keep changing the duration secondary; do not require a setup questionnaire every time.

The wording must make clear that this is an approximate active-practice commitment, with room to finish the current interaction. It is not a promise that all due work will be cleared in five minutes.

### During practice

Use one subdued bar with a readable label such as **“About 3 minutes left.”** Its defined meaning is elapsed active practice against the chosen time goal.

- Count reading, recall, and corrective feedback as practice.
- Exclude explicit pauses, hidden-tab time, loading, error recovery, and enforced waits. Do not infer that a quiet reader is inactive merely because no key was pressed.
- Do not erase progress or extend the time goal after a wrong answer. The bar measures the practice commitment, not correctness or mastery.
- Keep the indicator in a stable location outside the main reading area. Avoid a ticking seconds display, flashy animation, or repeated screen-reader announcements by default.
- Allow an alternative without a numeric countdown for learners who find clocks distracting or pressuring.
- Save enough session state to resume without resetting the commitment after a refresh. Keep it scoped to the learner and language.

These are proposed design choices to validate, not independently proven ADHD accommodations.

### At the stopping point

Stop admitting additional work, allow the current answer and any necessary feedback to finish, then present an explicit stopping point. Offer **Finish** and **Continue practicing** without automatically extending the session.

If the queue becomes unavailable earlier, end early rather than filling time with unnecessary repetitions. Explain that the learner is caught up for now. If more reviews remain, do not describe the day as complete.

### FSRS and learning safeguards

- Keep FSRS due dates and ratings independent of the session clock. Pausing a timer does not pause forgetting or change real elapsed time.
- Never shorten the 60-second first-recall delay to fit the time goal.
- Reserve capacity for existing due work and admit new words conservatively. A short session must not repeatedly spend its whole budget on introductions while older reviews accumulate.
- Leave time for initial recalls where practical. If a recall cannot occur before the stopping point, retain its real due date and make resumption clear instead of silently graduating the word.
- Ending a block does not mark outstanding work complete or clear the backlog.

Preserving due dates is not the same as proving that retention is unchanged. Shorter visits can leave more overdue work if users do not return. That trade-off must be measured.

## Implemented prototype

- The web app offers 3-, 5-, and 10-minute active-practice goals, defaulting to five minutes. The duration preference is device-local and scoped by account and learning language.
- Following interface feedback, the intro contains only “Start session,” duration choices, and the start action. The numeric countdown is always shown during practice; the earlier proposal for a clock toggle was dropped to reduce clutter.
- The progress bar measures active time, not correct answers, words mastered, or completion of the daily queue. Reading and feedback count; hidden-tab time, explicit pauses, loading, recovery, and unavailable practice do not.
- Reaching the goal does not submit or remove an answer. The current interaction and its feedback can finish before the stopping point. A learner can also stop early.
- Pausing preserves the current draft. Refreshing restores elapsed time in a paused block, but does not persist an unsubmitted draft or the exact prompt. Submitted answers retain the existing durable-outbox guarantees.
- A completed block stays completed. Continuing starts a fresh block after pending answers are synchronized. No next-due timer automatically reopens practice.
- Bounded practice prioritizes existing due work and disables learn-ahead. It stops admitting new words when fewer than 90 seconds remain. That reserve is a conservative product choice, not a proven guarantee that every first recall fits. The 60-second teaching delay, FSRS ratings, and due dates remain unchanged.
- Timer data is separate from answer persistence. If optional timer storage fails, the app warns that refreshing can reset the timer; answer-storage failures still block practice through the existing recovery flow.
- Recovery preserves undismissed corrective feedback. If local storage rejects an answer, retry rebuilds an unanswered prompt from a fresh snapshot instead of treating the failed submission as a stopping point. Rebuilding a rejected teaching prompt may bypass the new-word reserve once; subsequent selections use the normal budget. An unsubmitted typed draft is not preserved across this reload.

The controller lives in `apps/web/src/features/practice/practice-block.ts`. The reusable engine policy is optional, so callers outside bounded web practice retain their previous scheduling selection behavior. No database migration is required. Preferences do not synchronize across devices. Other tabs adopt saved changes without automatically starting another clock, and stale tabs check for newer data before writing. This localStorage synchronization is best effort, not an atomic cross-tab lock.

## What to validate before committing to the design

Use small formative sessions with adults with ADHD and differing timer preferences. A small usability study can find problems; it cannot establish clinical effectiveness or a universal optimal duration.

Compare a quiet remaining-time display with a less clock-focused version of the same bounded practice block. If users reject a time goal itself, compare a small fixed-work block with an approximate duration range. Do not present that work estimate as an exact finish time.

Ask whether participants can explain:

1. How long they have committed to practice.
2. What the progress bar measures.
3. Whether an incorrect answer adds time.
4. Whether stopping loses learning progress.
5. Whether finishing the block means all reviews are complete.

Observe perceived pressure, confidence about stopping, initiation, early abandonment, and successful resumption. Also monitor rushing errors, later recall, the overdue queue, and coverage of existing reviews. Do not optimize only for completion percentages or longer time in the app.

## Sources and access limits

1. **Metcalfe, K. B., McFeaters, C. D., & Voyer, D. (2024).** _Time-Perception Deficits in Attention-Deficit/Hyperactivity Disorder: A Systematic Review and Meta-Analysis._ [DOI](https://doi.org/10.1080/87565641.2023.2293712). Publisher abstract and Europe PMC indexed abstract reviewed; full paper was not reviewed.
2. **W3C WAI.** _Provide Information So a User Can Complete and Prepare for a Task._ [Design pattern](https://www.w3.org/WAI/WCAG2/supplemental/patterns/o5p04-task-expectations/). Supplemental cognitive accessibility guidance, not a comparative trial.
3. **W3C WAI.** _Make Each Step Clear._ [Design pattern](https://www.w3.org/WAI/WCAG2/supplemental/patterns/o1p04-clear-steps/).
4. **Kenter, R. M. F., Schønning, A., & Inal, Y. (2022).** _Internet-Delivered Self-help for Adults With ADHD (MyADHD): Usability Study._ JMIR Formative Research, 6(10), e37137. [Full text](https://formative.jmir.org/2022/10/e37137), [DOI](https://doi.org/10.2196/37137).
5. **Villar, A., Callegaro, M., & Yang, Y. (2013).** _Where Am I? A Meta-Analysis of Experiments on the Effects of Progress Indicators for Web Surveys._ Social Science Computer Review, 31(6), 744–762. [Authors' publication record and abstract](https://research.google/pubs/where-am-i-a-meta-analysis-of-experiments-on-the-effects-of-progress-indicators-for-web-surveys/), [DOI](https://doi.org/10.1177/0894439313497468). Abstract reviewed, not all 32 underlying experiments.
6. **Biwer, F., Wiradhany, W., oude Egbrink, M. G. A., & de Bruin, A. B. H. (2023).** _Understanding effort regulation: Comparing ‘Pomodoro’ breaks and self-regulated breaks._ [DOI](https://doi.org/10.1111/bjep.12593), [PubMed](https://pubmed.ncbi.nlm.nih.gov/36859717/). Europe PMC indexed abstract reviewed; publisher full text was not accessible through the fetch tool.
7. **Smits, E. J. C., Wenzel, N., & de Bruin, A. (2025).** _Investigating the Effectiveness of Self-Regulated, Pomodoro, and Flowtime Break-Taking Techniques Among Students._ Behavioral Sciences, 15(7), 861. [DOI](https://doi.org/10.3390/bs15070861), [PubMed](https://pubmed.ncbi.nlm.nih.gov/40723645/). Europe PMC indexed abstract reviewed.
8. **W3C WAI.** _Understanding Success Criterion 2.2.1: Timing Adjustable._ [WCAG 2.2 explanation](https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable.html).
9. **Anki Manual.** _Preferences: Scheduler; Timebox time limit._ [Manual](https://docs.ankiweb.net/preferences.html#scheduler). Product precedent, not efficacy evidence.

The literature search was targeted, not a systematic review. It did not identify a direct comparison of these session-duration designs in an FSRS vocabulary app for adults with ADHD. Generic “ADHD UX” articles and AI skill pages making unsupported universal claims were excluded from the evidence base.
